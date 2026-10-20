import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import type { Category } from '../domain.js';
import { notFound } from '../errors.js';
import { decodeCursor, page, pagingQuery } from '../paging.js';
import { toProfile, type ProfileJson } from '../profiles.js';
import { MemberList, MemberRatingList, MemberSummary } from '../schemas.js';
import { roundMatch, taste, TASTE_DESCRIPTION } from '../taste.js';

type MemberRow = {
  profile: ProfileJson;
  places_added: number;
  ratings: number;
  wishlist_to_visit: number;
  last_active_at: Date;
  match: number | null;
  shared: number | null;
};

export function memberRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  /** Members as seen by [me] (taste match with me), all of them or one; deleted accounts never. */
  const members = (me: string, id?: string) => sql<MemberRow[]>`
    select profile_json(u) as profile,
           (select count(*)::int from places p where p.added_by = u.id) as places_added,
           (select count(*)::int from ratings r where r.user_id = u.id) as ratings,
           (select count(*)::int from wishlist_items w where w.user_id = u.id and w.visited_on is null)
             as wishlist_to_visit,
           greatest(
             u.created_at,
             (select max(created_at) from places p where p.added_by = u.id),
             (select max(updated_at) from ratings r where r.user_id = u.id),
             (select max(created_at) from comments c where c.user_id = u.id),
             (select max(coalesce(updated_at, created_at)) from wishlist_items w where w.user_id = u.id)
           ) as last_active_at,
           t.match,
           case when u.id = ${me} then null else coalesce(t.shared, 0) end as shared
    from users u
    left join (${taste(sql, me)}) t on t.user_id = u.id
    where u.status <> 'deleted' ${id ? sql`and u.id = ${id}` : sql``}
    order by last_active_at desc, u.id
  `;
  const toSummary = (r: MemberRow) => ({
    profile: toProfile(r.profile, ctx.urls),
    places_added: r.places_added,
    ratings: r.ratings,
    wishlist_to_visit: r.wishlist_to_visit,
    last_active_at: r.last_active_at.toISOString(),
    match: roundMatch(r.match),
    shared: r.shared,
  });
  const idParams = z.object({ id: z.uuid() });

  app.get(
    '/members',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Members'],
        summary: 'Everyone in the network',
        description:
          'All members except deleted accounts, most recently active first — the network is small, so the list ' +
          'is not paged. ' +
          TASTE_DESCRIPTION,
        response: { 200: MemberList },
      },
    },
    async (req) => {
      const rows = await members(req.user.id);
      return { items: rows.map(toSummary), total: rows.length };
    },
  );

  app.get(
    '/members/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Members'],
        summary: 'One member',
        description:
          'As in GET /members, also for someone who has not added any place. 404 for unknown or deleted accounts. ' +
          TASTE_DESCRIPTION,
        params: idParams,
        response: { 200: MemberSummary },
      },
    },
    async (req) => {
      const [row] = await members(req.user.id, req.params.id);
      if (!row) throw notFound('Member');
      return toSummary(row);
    },
  );

  app.get(
    '/members/:id/ratings',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Members'],
        summary: "A member's ratings",
        description:
          'Places the member rated with their scores, latest first. Visit dates are private and left out. 404 for ' +
          'unknown or deleted accounts.',
        params: idParams,
        querystring: z.object({ ...pagingQuery() }),
        response: { 200: MemberRatingList },
      },
    },
    async (req) => {
      const [member] = await sql`select 1 from users where id = ${req.params.id} and status <> 'deleted'`;
      if (!member) throw notFound('Member');
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
          updated_at: Date;
          total: number;
        }[]
      >`
        select r.place_id, p.name as place_name, p.category, r.vibe, r.offer, r.service, r.value, r.overall,
               r.updated_at, (count(*) over ())::int as total
        from ratings r join places p on p.id = r.place_id
        where r.user_id = ${req.params.id}
        order by r.updated_at desc, r.place_id
        limit ${req.query.limit} offset ${offset}
      `;
      return page(
        rows.map((r) => ({
          place: { id: r.place_id, name: r.place_name, category_id: r.category },
          scores: { vibe: r.vibe, offer: r.offer, service: r.service, value: r.value },
          overall: r.overall,
          updated_at: r.updated_at.toISOString(),
        })),
        offset,
        rows[0]?.total ?? 0,
      );
    },
  );
}
