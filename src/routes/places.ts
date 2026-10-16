import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { view } from '../app.js';
import { CATEGORY_ID, requireActiveCategory } from '../categories.js';
import { isMapsLink } from '../maps-link.js';
import { CRITERIA, monthStart, type CriterionKey } from '../domain.js';
import { HttpError, notFound } from '../errors.js';
import { decodeCursor, page, pagingQuery } from '../paging.js';
import { releaseFiles } from '../photo-store.js';
import { notifyNewPlace } from '../notifications.js';
import { placeAuthor, requireOwnerOrAdmin } from '../place-access.js';
import { PLACE_SORTS, queryPlaces, toPhoto, toPlaceSummary } from '../places-query.js';
import { toProfile, type ProfileJson } from '../profiles.js';
import { attachRatingPhotos, awardGoldStar, ratingBody } from '../rating-logic.js';
import { CardStyle, ErrorBody, PlaceDetail, PlaceList, SavedResult } from '../schemas.js';
import { selectComments, toComment } from './comments.js';
import { starsLeft } from './me.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

const placeFields = {
  name: z.string().trim().min(1).max(120),
  category_id: z.string().regex(CATEGORY_ID).meta({ description: 'An active category id (GET /meta)' }),
  status: z.enum(['active', 'temporarily_closed', 'closed']),
  price_level: z.number().int().min(1).max(4).nullable(),
  address: z.string().trim().max(200).nullable(),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  description: z.string().trim().max(500).nullable(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10),
  opening_hours: z
    .array(z.object({ day: z.number().int().min(0).max(6), open: hhmm, close: hhmm }))
    .max(21)
    .nullable(),
  google_place_id: z.string().max(200).nullable(),
  google_maps_url: z
    .string()
    .max(500)
    .refine((v) => {
      try {
        return isMapsLink(new URL(v));
      } catch {
        return false;
      }
    }, 'expected a Google Maps link (https)')
    .nullable()
    .meta({ description: 'A Google Maps link to the place (e.g. `url` from POST /maps-links/resolve)' }),
  card_style: CardStyle.partial().meta({ description: 'Send only the parts to change' }),
};

const createPlace = z.object({
  name: placeFields.name,
  category_id: placeFields.category_id,
  location: placeFields.location,
  status: placeFields.status.default('active'),
  price_level: placeFields.price_level.default(null),
  address: placeFields.address.default(null),
  description: placeFields.description.default(null),
  tags: placeFields.tags.default([]),
  opening_hours: placeFields.opening_hours.default(null),
  google_place_id: placeFields.google_place_id.default(null),
  google_maps_url: placeFields.google_maps_url.default(null),
  card_style: placeFields.card_style.default({}),
  rating: ratingBody.omit({ photo_ids: true }).meta({ description: "The author's own rating, required" }),
  photo_ids: z
    .array(z.uuid())
    .min(1)
    .meta({ description: 'Photos uploaded with POST /photos; at least one (every rating has a photo)' }),
  gold_star: z.boolean().default(false).meta({ description: 'Also give it a gold star (uses this month’s quota)' }),
});

const updatePlace = z.object(placeFields).omit({ location: true }).partial().extend({
  location: placeFields.location.optional(),
});

const idParams = z.object({ id: z.uuid() });

/** Comma-separated list in a query string. */
const csv = <T extends z.ZodType>(item: T) =>
  z
    .string()
    .optional()
    .transform((s, c) => {
      if (!s) return undefined;
      const parsed = z.array(item).safeParse(s.split(',').map((x) => x.trim()));
      if (!parsed.success) {
        c.addIssue({ code: 'custom', message: parsed.error.issues.map((i) => i.message).join('; ') });
        return z.NEVER;
      }
      return parsed.data as z.output<T>[];
    });

const flag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

const bbox = z
  .string()
  .optional()
  .meta({ description: 'Map viewport: minLng,minLat,maxLng,maxLat', example: '20.9,52.15,21.15,52.3' })
  .transform((s, c) => {
    if (s == null) return undefined;
    const n = s.split(',').map(Number);
    const [minLng, minLat, maxLng, maxLat] = n as [number, number, number, number];
    const ok =
      n.length === 4 &&
      n.every(Number.isFinite) &&
      minLng >= -180 &&
      maxLng <= 180 &&
      minLat >= -90 &&
      maxLat <= 90 &&
      minLng < maxLng &&
      minLat < maxLat;
    if (!ok) {
      c.addIssue({ code: 'custom', message: 'bbox must be minLng,minLat,maxLng,maxLat' });
      return z.NEVER;
    }
    return { minLng, minLat, maxLng, maxLat };
  });

const searchQuery = z
  .object({
    q: z
      .string()
      .max(100)
      .optional()
      .meta({ description: 'Name, description, address or tags; ignores case and Polish accents' }),
    categories: csv(z.string().min(1)).meta({ description: 'Comma-separated category ids, any of them' }),
    min_rating: z.coerce.number().min(0).max(5).optional(),
    gold_only: flag,
    tags: csv(z.string().min(1)).meta({ description: 'Comma-separated, at least one of them' }),
    prices: csv(z.coerce.number().int().min(1).max(4)).meta({ description: 'Comma-separated price levels' }),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radius_m: z.coerce.number().positive().max(100_000).optional(),
    bbox,
    added_by: z.uuid().optional(),
    unrated_only: flag.meta({ description: 'Places I have not rated' }),
    saved_only: flag,
    include_closed: flag.meta({ description: 'Closed places are hidden unless this is true' }),
    sort: z.enum(PLACE_SORTS).default('best'),
    ...pagingQuery(500),
  })
  .refine((q) => (q.lat == null) === (q.lng == null), { message: 'lat and lng go together' })
  .refine((q) => q.lat != null || (q.sort !== 'nearest' && q.radius_m == null), {
    message: 'sort=nearest and radius_m need lat and lng',
  });

const nearQuery = z
  .object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() })
  .refine((q) => (q.lat == null) === (q.lng == null), { message: 'lat and lng go together' });

export async function loadPlace(ctx: Ctx, placeId: string, userId: string, near?: { lat: number; lng: number }) {
  const { sql, config } = ctx;
  const v = view(ctx);
  const month = monthStart(v.now, config.TIME_ZONE);
  const [row] = await queryPlaces(sql, {
    userId,
    month,
    starRankBonus: await ctx.settings.get('starRankBonus'),
    ids: [placeId],
    near,
  });
  if (!row) throw notFound('Place');

  const [[extra], photos, [criteria], distribution, [mine], awarders, [myStar], comments, left] = await Promise.all([
    sql<{ google_place_id: string | null; google_maps_url: string | null }[]>`
      select google_place_id, google_maps_url from places where id = ${placeId}
    `,
    sql<
      {
        id: string;
        hash: string;
        blurhash: string | null;
        width: number | null;
        height: number | null;
        uploaded_by: string;
      }[]
    >`
      select id, hash, blurhash, width, height, uploaded_by from place_photos
      where place_id = ${placeId} order by created_at, id
    `,
    sql<Record<string, number | null>[]>`
      select avg(vibe)::numeric(3, 2) as vibe, avg(offer)::numeric(3, 2) as offer,
             avg(service)::numeric(3, 2) as service, avg(value)::numeric(3, 2) as value,
             count(service)::int as service_count, count(value)::int as value_count
      from ratings where place_id = ${placeId}
    `,
    sql<{ stars: number; n: number }[]>`
      select round(overall)::int as stars, count(*)::int as n from ratings where place_id = ${placeId} group by 1
    `,
    sql<{ vibe: number; offer: number; service: number | null; value: number | null; visited_on: string | null }[]>`
      select vibe, offer, service, value, to_char(visited_on, 'YYYY-MM-DD') as visited_on
      from ratings where place_id = ${placeId} and user_id = ${userId}
    `,
    sql<{ profile: ProfileJson }[]>`
      select profile_json(u) as profile from stars s join users u on u.id = s.user_id
      where s.place_id = ${placeId} order by s.created_at desc
    `,
    sql<{ created_at: Date }[]>`
      select created_at from stars where place_id = ${placeId} and user_id = ${userId} and month = ${month}::date
    `,
    selectComments(ctx, { placeId }),
    starsLeft(ctx, userId, month),
  ]);

  const breakdown = CRITERIA.map((c) => ({
    key: c.key,
    average: criteria?.[c.key] ?? null,
    count: c.required ? row.rating_count : (criteria?.[`${c.key}_count`] ?? 0),
  }));
  const strongest = breakdown
    .filter((c) => c.average != null)
    .reduce<(typeof breakdown)[number] | null>((best, c) => (!best || c.average! > best.average! ? c : best), null);
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const d of distribution) dist[d.stars as 1 | 2 | 3 | 4 | 5] = d.n;

  return {
    ...toPlaceSummary(row, v),
    google_place_id: extra!.google_place_id,
    google_maps_url: extra!.google_maps_url,
    opening_hours: row.opening_hours,
    photos: photos.map((p) => ({ ...toPhoto(p, ctx.urls), uploaded_by: p.uploaded_by })),
    criteria: breakdown,
    strongest_criterion: (strongest?.key ?? null) as CriterionKey | null,
    rating_distribution: dist,
    my_scores: mine ? { vibe: mine.vibe, offer: mine.offer, service: mine.service, value: mine.value } : null,
    my_visited_on: mine?.visited_on ?? null,
    gold_star_awarders: awarders.map((a) => toProfile(a.profile, ctx.urls)),
    my_gold_star: myStar ? { awarded_at: myStar.created_at.toISOString() } : null,
    can_revoke_gold_star: !!myStar,
    gold_stars_left: left,
    comments: comments.map((c) => toComment(ctx, c, userId)),
    is_mine: row.author.id === userId,
  };
}

export function placeRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;

  app.get(
    '/places',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Search places',
        description:
          'Search, filter and sort. `best` ranks by rank_score (rating pulled towards the network average with ' +
          'the weight of 3 ratings, plus a bonus per gold star); `gold_stars` by all-time gold stars; `nearest` ' +
          'by distance; `newest`; `most_commented`. Ties are broken stably. Closed places are hidden unless ' +
          '`include_closed=true`. For the map, pass `bbox` (the visible area) with a `limit` of up to 500.',
        querystring: searchQuery,
        response: { 200: PlaceList },
      },
    },
    async (req) => {
      const qs = req.query;
      const offset = decodeCursor(qs.cursor);
      const rows = await queryPlaces(sql, {
        userId: req.user.id,
        month: monthStart(ctx.now(), config.TIME_ZONE),
        starRankBonus: await ctx.settings.get('starRankBonus'),
        q: qs.q,
        categories: qs.categories,
        minRating: qs.min_rating,
        goldOnly: qs.gold_only,
        tags: qs.tags,
        prices: qs.prices,
        near: qs.lat != null && qs.lng != null ? { lat: qs.lat, lng: qs.lng } : undefined,
        radiusM: qs.radius_m,
        bbox: qs.bbox,
        addedBy: qs.added_by,
        unratedOnly: qs.unrated_only,
        savedOnly: qs.saved_only,
        includeClosed: qs.include_closed,
        sort: qs.sort,
        limit: qs.limit,
        offset,
      });
      const v = view(ctx);
      return page(
        rows.map((r) => toPlaceSummary(r, v)),
        offset,
        rows[0]?.total ?? 0,
      );
    },
  );

  app.post(
    '/places',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Add a place',
        description:
          'Adds the place together with the author’s rating and its photos (and optionally a gold star) in one ' +
          'transaction. Upload the photos first with `POST /photos`. 409 `place_exists` (with `place_id`) when a ' +
          'place with the same `google_place_id` is already there.',
        body: createPlace,
        response: { 201: PlaceDetail, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      const b = req.body;
      await requireActiveCategory(sql, b.category_id);
      const id = await sql.begin(async (tx) => {
        if (b.google_place_id) {
          const [existing] = await tx<
            { id: string }[]
          >`select id from places where google_place_id = ${b.google_place_id}`;
          if (existing) {
            throw new HttpError(409, 'place_exists', 'This place is already on the map', { place_id: existing.id });
          }
        }
        const [created] = await tx<{ id: string }[]>`
          insert into places (name, category, status, price_level, address, lat, lng, description, tags,
                              opening_hours, google_place_id, google_maps_url, added_by, card_layout, photo_filter,
                              filter_intensity, card_color)
          values (${b.name}, ${b.category_id}, ${b.status}, ${b.price_level}, ${b.address}, ${b.location.lat},
                  ${b.location.lng}, ${b.description}, ${b.tags}, ${b.opening_hours ? tx.json(b.opening_hours) : null},
                  ${b.google_place_id}, ${b.google_maps_url}, ${req.user.id}, ${b.card_style.layout ?? 'auto'},
                  ${b.card_style.photo_filter ?? 'none'}, ${b.card_style.filter_intensity ?? 100},
                  ${b.card_style.color ?? null})
          returning id
        `;
        const placeId = created!.id;
        const r = b.rating;
        await tx`
          insert into ratings (user_id, place_id, vibe, offer, service, value)
          values (${req.user.id}, ${placeId}, ${r.vibe}, ${r.offer}, ${r.service}, ${r.value})
        `;
        await attachRatingPhotos(tx, ctx, placeId, req.user.id, b.photo_ids);
        if (b.gold_star) await awardGoldStar(tx, ctx, placeId, req.user.id);
        return placeId;
      });
      notifyNewPlace(ctx, id, req.user.id);
      return reply.status(201).send(await loadPlace(ctx, id, req.user.id));
    },
  );

  app.get(
    '/places/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Place details',
        description: 'Pass `lat`/`lng` to get `distance_m`. Includes photos, comments and gold star givers.',
        params: idParams,
        querystring: nearQuery,
        response: { 200: PlaceDetail },
      },
    },
    async (req) => {
      const { lat, lng } = req.query;
      return loadPlace(ctx, req.params.id, req.user.id, lat != null && lng != null ? { lat, lng } : undefined);
    },
  );

  app.patch(
    '/places/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Edit a place',
        description: 'The person who added it, or an admin. Send just the fields to change.',
        params: idParams,
        body: updatePlace,
        response: { 200: PlaceDetail },
      },
    },
    async (req) => {
      requireOwnerOrAdmin(req.user, await placeAuthor(ctx, req.params.id), 'edit this place');
      const b = req.body;
      const set: Record<string, unknown> = {};
      if (b.name !== undefined) set.name = b.name;
      if (b.category_id !== undefined) {
        // A place may stay in a retired category, but cannot move into one.
        const [current] = await sql<{ category: string }[]>`select category from places where id = ${req.params.id}`;
        if (b.category_id !== current?.category) await requireActiveCategory(sql, b.category_id);
        set.category = b.category_id;
      }
      if (b.status !== undefined) set.status = b.status;
      if (b.price_level !== undefined) set.price_level = b.price_level;
      if (b.address !== undefined) set.address = b.address;
      if (b.location !== undefined) Object.assign(set, { lat: b.location.lat, lng: b.location.lng });
      if (b.description !== undefined) set.description = b.description;
      if (b.tags !== undefined) set.tags = b.tags;
      if (b.opening_hours !== undefined) set.opening_hours = b.opening_hours ? sql.json(b.opening_hours) : null;
      if (b.google_place_id !== undefined) set.google_place_id = b.google_place_id;
      if (b.google_maps_url !== undefined) set.google_maps_url = b.google_maps_url;
      if (b.card_style?.layout !== undefined) set.card_layout = b.card_style.layout;
      if (b.card_style?.photo_filter !== undefined) set.photo_filter = b.card_style.photo_filter;
      if (b.card_style?.filter_intensity !== undefined) set.filter_intensity = b.card_style.filter_intensity;
      if (b.card_style?.color !== undefined) set.card_color = b.card_style.color;
      if (Object.keys(set).length) {
        await sql`update places set ${sql(set)}, updated_at = now() where id = ${req.params.id}`;
      }
      return loadPlace(ctx, req.params.id, req.user.id);
    },
  );

  app.delete(
    '/places/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Delete a place',
        description:
          'The person who added it, or an admin. Removes its ratings, photos, gold stars and comments. To mark a ' +
          'place that no longer exists, set `status` to `closed` instead.',
        params: idParams,
      },
    },
    async (req, reply) => {
      requireOwnerOrAdmin(req.user, await placeAuthor(ctx, req.params.id), 'delete this place');
      await sql.begin(async (tx) => {
        const photos = await tx<{ hash: string }[]>`select hash from place_photos where place_id = ${req.params.id}`;
        await tx`delete from places where id = ${req.params.id}`;
        await releaseFiles(
          tx,
          ctx.photos,
          photos.map((p) => p.hash),
        );
      });
      return reply.status(204).send();
    },
  );

  const savedSchema = (summary: string) => ({
    tags: ['Places'],
    summary,
    params: idParams,
    response: { 200: SavedResult },
  });

  app.put('/places/:id/saved', { preHandler: ctx.auth, schema: savedSchema('Save a place for later') }, async (req) => {
    await placeAuthor(ctx, req.params.id);
    await sql`
      insert into saved_places (user_id, place_id) values (${req.user.id}, ${req.params.id}) on conflict do nothing
    `;
    return { is_saved: true };
  });

  app.delete('/places/:id/saved', { preHandler: ctx.auth, schema: savedSchema('Unsave a place') }, async (req) => {
    await sql`delete from saved_places where user_id = ${req.user.id} and place_id = ${req.params.id}`;
    return { is_saved: false };
  });
}
