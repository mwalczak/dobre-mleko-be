import type { App, Ctx } from '../app.js';
import { view } from '../app.js';
import { monthStart, type Category } from '../domain.js';
import { queryPlaces, toPlaceSummary } from '../places-query.js';
import { toProfile, type ProfileJson } from '../profiles.js';
import { MyStats, NetworkStats } from '../schemas.js';
import { starsLeft } from './me.js';
import { roundMatch, taste, TASTE_DESCRIPTION } from '../taste.js';

/** Overall ratings rounded to whole stars, 1–5. */
function distribution(rows: { stars: number; n: number }[]) {
  const d = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rows) d[r.stars as 1 | 2 | 3 | 4 | 5] = r.n;
  return d;
}

export function statsRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;

  app.get(
    '/stats/network',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Stats'],
        summary: 'Network stats',
        description:
          'Totals, gold stars this month, the star of the month, top 10 places, places per category and ratings ' +
          'per week for the last 12 weeks.',
        response: { 200: NetworkStats },
      },
    },
    async (req) => {
      const v = view(ctx);
      const month = monthStart(v.now, config.TIME_ZONE);
      const base = { userId: req.user.id, month, starRankBonus: await ctx.settings.get('starRankBonus') };
      const [[totals], categories, weeks, top, [starOfMonth]] = await Promise.all([
        sql<{ members: number; places: number; ratings: number; average: number | null; stars: number }[]>`
          select
            (select count(*)::int from users where status <> 'deleted') as members,
            (select count(*)::int from places) as places,
            (select count(*)::int from ratings) as ratings,
            (select avg(overall)::numeric(3, 2) from ratings) as average,
            (select count(*)::int from stars where month = ${month}::date) as stars
        `,
        sql<{ category: Category; n: number }[]>`
          select category, count(*)::int as n from places group by category order by n desc, category
        `,
        // Monday-based weeks in the app's time zone, oldest first, the current week last.
        sql<{ n: number }[]>`
          select (
            select count(*)::int from ratings r where r.created_at >= w.start and r.created_at < w.start + interval '1 week'
          ) as n
          from generate_series(11, 0, -1) as i,
          lateral (
            select (date_trunc('week', ${v.now}::timestamptz at time zone ${config.TIME_ZONE}) - i * interval '1 week')
              at time zone ${config.TIME_ZONE} as start
          ) w
          order by i desc
        `,
        queryPlaces(sql, { ...base, ratedOnly: true, sort: 'best', limit: 10 }),
        queryPlaces(sql, { ...base, sort: 'gold_stars_month', limit: 1 }),
      ]);
      return {
        members: totals!.members,
        places: totals!.places,
        ratings: totals!.ratings,
        average_rating: totals!.average,
        month,
        gold_stars_this_month: totals!.stars,
        star_of_the_month:
          starOfMonth && starOfMonth.gold_stars_this_month > 0
            ? { place: toPlaceSummary(starOfMonth, v), stars: starOfMonth.gold_stars_this_month }
            : null,
        top: top.map((r) => toPlaceSummary(r, v)),
        categories: categories.map((c) => ({ category_id: c.category, count: c.n })),
        weekly_activity: weeks.map((w) => w.n),
      };
    },
  );

  app.get(
    '/stats/me',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Stats'],
        summary: 'My stats',
        description: TASTE_DESCRIPTION,
        response: { 200: MyStats },
      },
    },
    async (req) => {
      const v = view(ctx);
      const me = req.user.id;
      const month = monthStart(v.now, config.TIME_ZONE);
      const [[s], dist, categories, matches, starred] = await Promise.all([
        sql<
          {
            places_added: number;
            ratings: number;
            average_given: number | null;
            comments: number;
            saved: number;
            stars_total: number;
            stars_month: number;
          }[]
        >`
          select
            (select count(*)::int from places where added_by = ${me}) as places_added,
            (select count(*)::int from ratings where user_id = ${me}) as ratings,
            (select avg(overall)::numeric(3, 2) from ratings where user_id = ${me}) as average_given,
            (select count(*)::int from comments where user_id = ${me}) as comments,
            (select count(*)::int from saved_places where user_id = ${me}) as saved,
            (select count(*)::int from stars where user_id = ${me}) as stars_total,
            (select count(*)::int from stars where user_id = ${me} and month = ${month}::date) as stars_month
        `,
        sql<{ stars: number; n: number }[]>`
          select round(overall)::int as stars, count(*)::int as n from ratings where user_id = ${me} group by 1
        `,
        sql<{ category: Category; n: number }[]>`
          select p.category, count(*)::int as n from ratings r join places p on p.id = r.place_id
          where r.user_id = ${me} group by p.category order by n desc, p.category
        `,
        sql<{ profile: ProfileJson; match: number; shared: number }[]>`
          select profile_json(u) as profile, t.match, t.shared
          from (${taste(sql, me)}) t join users u on u.id = t.user_id
          where u.status <> 'deleted' and t.match is not null
          order by t.match desc, t.shared desc, u.id
          limit 3
        `,
        queryPlaces(sql, {
          userId: me,
          month,
          starRankBonus: await ctx.settings.get('starRankBonus'),
          addedBy: me,
          starredOnly: true,
          includeClosed: true,
          sort: 'gold_stars',
          limit: 100,
        }),
      ]);
      return {
        places_added: s!.places_added,
        ratings_given: s!.ratings,
        average_given: s!.average_given,
        distribution: distribution(dist),
        categories: categories.map((c) => ({ category_id: c.category, count: c.n })),
        taste_matches: matches.map((m) => ({
          profile: toProfile(m.profile, ctx.urls),
          match: roundMatch(m.match)!,
          shared: m.shared,
        })),
        my_places_with_stars: starred.map((r) => ({ place: toPlaceSummary(r, v), stars: r.gold_star_count })),
        comments: s!.comments,
        saved: s!.saved,
        gold_stars: {
          given_total: s!.stars_total,
          given_this_month: s!.stars_month,
          left: await starsLeft(ctx, me, month),
        },
      };
    },
  );
}
