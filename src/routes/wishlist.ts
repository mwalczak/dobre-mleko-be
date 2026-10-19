import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { localDate, oldestVisitDate } from '../domain.js';
import { invalidInput, notAuthorized, notFound } from '../errors.js';
import { decodeCursor, page, pagingQuery } from '../paging.js';
import { toProfile, type ProfileJson } from '../profiles.js';
import { WishlistItem, WishlistItemList } from '../schemas.js';

interface WishlistRow {
  id: string;
  user_id: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  description: string | null;
  url: string | null;
  visited_on: string | null;
  place_id: string | null;
  created_at: Date;
  updated_at: Date | null;
  owner: ProfileJson;
  total: number;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((s) => (s === '' ? null : s));

const fields = {
  name: z.string().trim().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: optionalText(200),
  description: optionalText(1000),
  url: z
    .string()
    .trim()
    .max(500)
    .regex(/^https?:\/\/\S+$/, 'url must be an http(s) link')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
};

const visitedOn = z.iso
  .date()
  .nullable()
  .optional()
  .meta({ description: 'YYYY-MM-DD, not later than today (Europe/Warsaw); null = not visited' });

const createBody = z.object(fields);
const updateBody = z.object({
  ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])),
  visited_on: visitedOn,
  place_id: z.uuid().nullable().optional().meta({ description: 'The regular place it was added as' }),
}) as z.ZodType<{
  name?: string;
  lat?: number;
  lng?: number;
  address?: string | null;
  description?: string | null;
  url?: string | null;
  visited_on?: string | null;
  place_id?: string | null;
}>;

const bboxQuery = z
  .string()
  .meta({ description: 'Map viewport: minLng,minLat,maxLng,maxLat', example: '20.9,52.15,21.15,52.3' })
  .transform((s, c) => {
    const n = s.split(',').map(Number);
    const [minLng, minLat, maxLng, maxLat] = n as [number, number, number, number];
    if (n.length !== 4 || !n.every(Number.isFinite) || minLng >= maxLng || minLat >= maxLat) {
      c.addIssue({ code: 'custom', message: 'bbox must be minLng,minLat,maxLng,maxLat' });
      return z.NEVER;
    }
    return { minLng, minLat, maxLng, maxLat };
  });

const visitedFilter = z
  .enum(['true', 'false'])
  .optional()
  .meta({ description: 'Only visited (`true`) or only not yet visited (`false`); both when left out' })
  .transform((v) => (v == null ? undefined : v === 'true'));

/** Rejects visit dates in the future or more than a year ago (in the network's time zone). */
export function checkVisitedOn(ctx: Ctx, date: string | null | undefined) {
  if (!date) return;
  if (date > localDate(ctx.now(), ctx.config.TIME_ZONE)) throw invalidInput('visited_on cannot be in the future');
  if (date < oldestVisitDate(ctx.now(), ctx.config.TIME_ZONE)) {
    throw invalidInput('visited_on can be at most a year ago');
  }
}

export function wishlistRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;
  const idParams = z.object({ id: z.uuid() });

  const toItem = (r: WishlistRow, userId: string) => ({
    id: r.id,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    address: r.address,
    description: r.description,
    url: r.url,
    visited_on: r.visited_on,
    place_id: r.place_id,
    owner: toProfile(r.owner, ctx.urls),
    is_mine: r.user_id === userId,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at?.toISOString() ?? null,
  });

  /** Items with their owners: not yet visited first, then by when they were added (newest first). */
  function select(where: ReturnType<typeof sql>, limit: number, offset: number): Promise<WishlistRow[]> {
    return sql<WishlistRow[]>`
      select w.id, w.user_id, w.name, w.lat, w.lng, w.address, w.description, w.url,
             to_char(w.visited_on, 'YYYY-MM-DD') as visited_on, w.place_id, w.created_at, w.updated_at,
             profile_json(u) as owner, (count(*) over ())::int as total
      from wishlist_items w join users u on u.id = w.user_id
      where u.status <> 'deleted' and ${where}
      order by (w.visited_on is not null), w.visited_on desc nulls first, w.created_at desc, w.id
      limit ${limit} offset ${offset}
    `;
  }

  const visitedClause = (visited: boolean | undefined) =>
    visited == null ? sql`true` : visited ? sql`w.visited_on is not null` : sql`w.visited_on is null`;

  async function loadItem(id: string, userId: string) {
    const [row] = await select(sql`w.id = ${id}`, 1, 0);
    if (!row) throw notFound('Wishlist item');
    return toItem(row, userId);
  }

  async function ownItem(id: string, userId: string) {
    const [item] = await sql<{ user_id: string }[]>`select user_id from wishlist_items where id = ${id}`;
    if (!item) throw notFound('Wishlist item');
    if (item.user_id !== userId) throw notAuthorized('Only the owner can change a wishlist item');
  }

  const listQuery = z.object({ visited: visitedFilter, ...pagingQuery(200) });

  app.get(
    '/me/wishlist',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Wishlist'],
        summary: 'My wishlist',
        description: 'Not yet visited first (newest first), then visited (most recent visit first).',
        querystring: listQuery,
        response: { 200: WishlistItemList },
      },
    },
    async (req) => {
      const offset = decodeCursor(req.query.cursor);
      const rows = await select(
        sql`w.user_id = ${req.user.id} and ${visitedClause(req.query.visited)}`,
        req.query.limit,
        offset,
      );
      return page(
        rows.map((r) => toItem(r, req.user.id)),
        offset,
        rows[0]?.total ?? 0,
      );
    },
  );

  app.get(
    '/members/:id/wishlist',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Wishlist'],
        summary: "A member's wishlist",
        description: "Everyone in the network sees everyone's wishlist. 404 for an unknown or deleted member.",
        params: idParams,
        querystring: listQuery,
        response: { 200: WishlistItemList },
      },
    },
    async (req) => {
      const [member] = await sql`select 1 from users where id = ${req.params.id} and status <> 'deleted'`;
      if (!member) throw notFound('Member');
      const offset = decodeCursor(req.query.cursor);
      const rows = await select(
        sql`w.user_id = ${req.params.id} and ${visitedClause(req.query.visited)}`,
        req.query.limit,
        offset,
      );
      return page(
        rows.map((r) => toItem(r, req.user.id)),
        offset,
        rows[0]?.total ?? 0,
      );
    },
  );

  app.get(
    '/wishlist',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Wishlist'],
        summary: "Everyone's wishlist items in a map viewport",
        description:
          'For the map layer: items of all members inside `bbox`. Visited items are left out unless ' +
          '`visited` says otherwise. Up to `limit` (max 500) items.',
        querystring: z.object({
          bbox: bboxQuery,
          visited: visitedFilter,
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: { 200: WishlistItemList },
      },
    },
    async (req) => {
      const { minLng, minLat, maxLng, maxLat } = req.query.bbox;
      const rows = await select(
        sql`w.geom && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)
            and ${visitedClause(req.query.visited ?? false)}`,
        req.query.limit,
        0,
      );
      return page(
        rows.map((r) => toItem(r, req.user.id)),
        0,
        rows.length,
      );
    },
  );

  app.get(
    '/wishlist/:id',
    {
      preHandler: ctx.auth,
      schema: { tags: ['Wishlist'], summary: 'A wishlist item', params: idParams, response: { 200: WishlistItem } },
    },
    async (req) => loadItem(req.params.id, req.user.id),
  );

  app.post(
    '/me/wishlist',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Wishlist'],
        summary: 'Add to my wishlist',
        description:
          'Name 1–120, description up to 1000, address up to 200 characters; `url` an http(s) link up to 500. ' +
          'A Google Maps link can be read with `POST /maps-links/resolve` first.',
        body: createBody,
        response: { 201: WishlistItem },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const [created] = await sql<{ id: string }[]>`
        insert into wishlist_items (user_id, name, lat, lng, address, description, url)
        values (${req.user.id}, ${b.name}, ${b.lat}, ${b.lng}, ${b.address ?? null}, ${b.description ?? null},
                ${b.url ?? null})
        returning id
      `;
      return reply.status(201).send(await loadItem(created!.id, req.user.id));
    },
  );

  app.patch(
    '/me/wishlist/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Wishlist'],
        summary: 'Change my wishlist item',
        description:
          'Only the fields given change. `visited_on` marks it visited (a date, not in the future nor more than a year ago) or not ' +
          "(null); `place_id` links the regular place it was added as. 403 for someone else's item.",
        params: idParams,
        body: updateBody,
        response: { 200: WishlistItem },
      },
    },
    async (req) => {
      await ownItem(req.params.id, req.user.id);
      const b = req.body;
      checkVisitedOn(ctx, b.visited_on);
      if (b.place_id) {
        const [place] = await sql`select 1 from places where id = ${b.place_id}`;
        if (!place) throw notFound('Place');
      }
      const changes = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
      if (Object.keys(changes).length) {
        await sql`
          update wishlist_items set ${sql(changes)}, updated_at = now() where id = ${req.params.id}
        `;
      }
      return loadItem(req.params.id, req.user.id);
    },
  );

  app.delete(
    '/me/wishlist/:id',
    {
      preHandler: ctx.auth,
      schema: { tags: ['Wishlist'], summary: 'Remove from my wishlist', params: idParams },
    },
    async (req, reply) => {
      await ownItem(req.params.id, req.user.id);
      await sql`delete from wishlist_items where id = ${req.params.id}`;
      return reply.status(204).send();
    },
  );
}
