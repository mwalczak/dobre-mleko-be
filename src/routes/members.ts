import type { App, Ctx } from '../app.js';
import { toProfile, type ProfileJson } from '../profiles.js';
import { MemberList } from '../schemas.js';
import { roundMatch, taste, TASTE_DESCRIPTION } from '../taste.js';

export function memberRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

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
      const me = req.user.id;
      const rows = await sql<
        {
          profile: ProfileJson;
          places_added: number;
          ratings: number;
          wishlist_to_visit: number;
          last_active_at: Date;
          match: number | null;
          shared: number | null;
        }[]
      >`
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
        where u.status <> 'deleted'
        order by last_active_at desc, u.id
      `;
      return {
        items: rows.map((r) => ({
          profile: toProfile(r.profile, ctx.urls),
          places_added: r.places_added,
          ratings: r.ratings,
          wishlist_to_visit: r.wishlist_to_visit,
          last_active_at: r.last_active_at.toISOString(),
          match: roundMatch(r.match),
          shared: r.shared,
        })),
        total: rows.length,
      };
    },
  );
}
