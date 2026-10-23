import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { view } from '../app.js';
import { requireCategories } from '../categories.js';
import { monthStart, type Category } from '../domain.js';
import { notFound } from '../errors.js';
import { notifyJoined, toNotificationPrefs, type NotifyColumns } from '../notifications.js';
import { decodeCursor, page, pagingQuery } from '../paging.js';
import { lockHash, releaseFiles } from '../photo-store.js';
import { queryPlaces, toPlaceSummary } from '../places-query.js';
import { toProfile, type ProfileJson } from '../profiles.js';
import { GoldStarQuota, Me, MyRatingList, NotificationPrefs, PlaceList } from '../schemas.js';
import { readImageUpload, storeImage } from '../uploads.js';

export async function starsLeft(ctx: Ctx, userId: string, month: string): Promise<number> {
  const [{ used }] = await ctx.sql<[{ used: number }]>`
    select count(*)::int as used from stars where user_id = ${userId} and month = ${month}::date
  `;
  return Math.max(0, (await ctx.settings.get('starsPerMonth')) - used);
}

export async function goldStarQuota(ctx: Ctx, userId: string) {
  const month = monthStart(ctx.now(), ctx.config.TIME_ZONE);
  return { per_month: await ctx.settings.get('starsPerMonth'), left: await starsLeft(ctx, userId, month), month };
}

export async function loadMe(ctx: Ctx, userId: string) {
  const [user] = await ctx.sql<
    ({
      profile: ProfileJson;
      email: string;
      profile_completed_at: Date | null;
    } & NotifyColumns)[]
  >`
    select profile_json(u) as profile, u.email, u.profile_completed_at, u.notify_new_places, u.notify_comments,
      u.notify_gold_stars, u.notify_joins
    from users u where u.id = ${userId}
  `;
  if (!user) throw notFound('User');
  const profile = toProfile(user.profile, ctx.urls);
  return {
    ...profile,
    email: user.email,
    is_admin: profile.role === 'admin',
    has_profile: !!user.profile_completed_at,
    notifications: toNotificationPrefs(user),
    gold_stars: await goldStarQuota(ctx, userId),
  };
}

/** Shown instead of the name of someone who deleted their account (PRODUCT_SPEC: „Były członek”). */
const DELETED_NAME = 'Były członek';

const displayName = z.string().trim().min(1).max(60);
// Trimmed; an empty badge clears it.
const badge = z
  .string()
  .trim()
  .max(16)
  .nullable()
  .transform((b) => b || null);
const favoriteCategories = z
  .array(z.string().min(1))
  .max(3)
  .refine((c) => new Set(c).size === c.length, 'Categories must be different');

export function meRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  app.get(
    '/me',
    { preHandler: ctx.auth, schema: { tags: ['Me'], summary: 'Me', response: { 200: Me } } },
    async (req) => loadMe(ctx, req.user.id),
  );

  app.post(
    '/me/profile',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Finish onboarding',
        description:
          'Sets the display name, badge (max 16 characters) and up to 3 favourite categories; `has_profile` becomes ' +
          'true. The first time, whoever put the e-mail on the list gets a push notification (`notifications.joins`).',
        body: z.object({
          display_name: displayName,
          badge: badge.default(null),
          favorite_categories: favoriteCategories.default([]),
        }),
        response: { 200: Me },
      },
    },
    async (req) => {
      const b = req.body;
      await requireCategories(sql, b.favorite_categories);
      const [before] = await sql<{ done: boolean }[]>`
        select profile_completed_at is not null as done from users where id = ${req.user.id}
      `;
      await sql`
        update users set
          name = ${b.display_name}, badge = ${b.badge}, favorite_categories = ${b.favorite_categories},
          profile_completed_at = coalesce(profile_completed_at, now())
        where id = ${req.user.id}
      `;
      if (!before?.done) notifyJoined(ctx, req.user.id);
      return loadMe(ctx, req.user.id);
    },
  );

  app.patch(
    '/me',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Update my profile',
        description: 'Send only the fields to change. Role and status cannot be changed here.',
        body: z.object({
          display_name: displayName.optional(),
          badge: badge.optional(),
          favorite_categories: favoriteCategories.optional(),
          notifications: NotificationPrefs.partial().optional(),
        }),
        response: { 200: Me },
      },
    },
    async (req) => {
      const b = req.body;
      const set: Record<string, unknown> = {};
      if (b.display_name !== undefined) set.name = b.display_name;
      if (b.badge !== undefined) set.badge = b.badge;
      if (b.favorite_categories !== undefined) {
        await requireCategories(sql, b.favorite_categories);
        set.favorite_categories = b.favorite_categories;
      }
      if (b.notifications?.new_places !== undefined) set.notify_new_places = b.notifications.new_places;
      if (b.notifications?.comments !== undefined) set.notify_comments = b.notifications.comments;
      if (b.notifications?.gold_stars !== undefined) set.notify_gold_stars = b.notifications.gold_stars;
      if (b.notifications?.joins !== undefined) set.notify_joins = b.notifications.joins;
      if (Object.keys(set).length) await sql`update users set ${sql(set)} where id = ${req.user.id}`;
      return loadMe(ctx, req.user.id);
    },
  );

  app.delete(
    '/me',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Delete my account',
        description:
          'Removes the personal data: e-mail, name, badge, avatar, Google/Apple ids, favourite categories, saved ' +
          'places, the wishlist, devices and the place on the access list. Places, ratings, photos and comments stay, shown as ' +
          'by "Były członek" (status `deleted`). Every session ends. Signing in again with the same e-mail starts ' +
          'a new account, once an admin puts it back on the list. ADMIN_EMAILS admins stay on the list.',
      },
    },
    async (req, reply) => {
      await sql.begin(async (tx) => {
        const [user] = await tx<{ email: string; avatar_hash: string | null }[]>`
          select email, avatar_hash from users where id = ${req.user.id} for update
        `;
        await tx`
          update users set
            status = 'deleted', name = ${DELETED_NAME}, email = ${`deleted-${req.user.id}@deleted.invalid`},
            google_sub = null, apple_sub = null, avatar_hash = null, avatar_url = null, badge = null,
            favorite_categories = '{}', notify_new_places = 'none', notify_comments = false,
            notify_gold_stars = false, notify_joins = false
          where id = ${req.user.id}
        `;
        await tx`delete from saved_places where user_id = ${req.user.id}`;
        await tx`delete from wishlist_items where user_id = ${req.user.id}`;
        await tx`delete from devices where user_id = ${req.user.id}`;
        if (!ctx.config.ADMIN_EMAILS.includes(user!.email)) {
          await tx`delete from allowed_emails where email = ${user!.email}`;
        }
        if (user!.avatar_hash) await releaseFiles(tx, ctx.photos, [user!.avatar_hash]);
      });
      return reply.status(204).send();
    },
  );

  app.put(
    '/me/avatar',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Upload my avatar',
        description: 'multipart/form-data with one image file. Replaces the Google picture.',
        consumes: ['multipart/form-data'],
        response: { 200: Me },
      },
    },
    async (req) => {
      const upload = await readImageUpload(req, ctx);
      await sql.begin(async (tx) => {
        const [old] = await tx<{ avatar_hash: string | null }[]>`
          select avatar_hash from users where id = ${req.user.id} for update
        `;
        await lockHash(tx, upload.hash);
        await storeImage(ctx, upload);
        await tx`update users set avatar_hash = ${upload.hash} where id = ${req.user.id}`;
        if (old?.avatar_hash && old.avatar_hash !== upload.hash) await releaseFiles(tx, ctx.photos, [old.avatar_hash]);
      });
      return loadMe(ctx, req.user.id);
    },
  );

  app.delete(
    '/me/avatar',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Remove my avatar',
        description: 'Falls back to the Google picture.',
        response: { 200: Me },
      },
    },
    async (req) => {
      await sql.begin(async (tx) => {
        const [old] = await tx<{ avatar_hash: string | null }[]>`
          select avatar_hash from users where id = ${req.user.id} for update
        `;
        await tx`update users set avatar_hash = null where id = ${req.user.id}`;
        if (old?.avatar_hash) await releaseFiles(tx, ctx.photos, [old.avatar_hash]);
      });
      return loadMe(ctx, req.user.id);
    },
  );

  app.get(
    '/me/gold-stars',
    {
      preHandler: ctx.auth,
      schema: { tags: ['Me'], summary: 'My gold stars left this month', response: { 200: GoldStarQuota } },
    },
    async (req) => goldStarQuota(ctx, req.user.id),
  );

  app.get(
    '/me/saved',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'My saved places',
        description: 'Same as `GET /places?saved_only=true&sort=newest`.',
        querystring: z.object({ ...pagingQuery() }),
        response: { 200: PlaceList },
      },
    },
    async (req) => {
      const offset = decodeCursor(req.query.cursor);
      const rows = await queryPlaces(sql, {
        userId: req.user.id,
        month: monthStart(ctx.now(), ctx.config.TIME_ZONE),
        starRankBonus: await ctx.settings.get('starRankBonus'),
        savedOnly: true,
        includeClosed: true,
        sort: 'newest',
        limit: req.query.limit,
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

  app.get(
    '/me/ratings',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'My ratings',
        querystring: z.object({ ...pagingQuery() }),
        response: { 200: MyRatingList },
      },
    },
    async (req) => {
      const offset = decodeCursor(req.query.cursor);
      const rows = await sql<
        {
          place_id: string;
          place_name: string;
          category: Category;
          vibe: number;
          offer: number;
          service: number | null;
          value: number | null;
          overall: number;
          visited_on: string | null;
          updated_at: Date;
          total: number;
        }[]
      >`
        select r.place_id, p.name as place_name, p.category, r.vibe, r.offer, r.service, r.value, r.overall,
               to_char(r.visited_on, 'YYYY-MM-DD') as visited_on, r.updated_at, (count(*) over ())::int as total
        from ratings r join places p on p.id = r.place_id
        where r.user_id = ${req.user.id}
        order by r.updated_at desc, r.place_id
        limit ${req.query.limit} offset ${offset}
      `;
      return page(
        rows.map((r) => ({
          place: { id: r.place_id, name: r.place_name, category_id: r.category },
          scores: { vibe: r.vibe, offer: r.offer, service: r.service, value: r.value },
          overall: r.overall,
          visited_on: r.visited_on,
          updated_at: r.updated_at.toISOString(),
        })),
        offset,
        rows[0]?.total ?? 0,
      );
    },
  );
}
