import type { Sql } from './db.js';

/** Fewer than this many places rated by both: no taste match. */
export const MIN_SHARED = 3;
/** Shrinkage: with n shared places the correlation counts n / (n + K), so a few lucky agreements stay near 50%. */
const K = 5;

export const TASTE_DESCRIPTION =
  'taste match = 0.5 + (r / 2) · n / (n + 5), where r is the Pearson correlation of overall ratings on the n ' +
  `places both rated (at least ${MIN_SHARED}; with no variation r is 1 when the ratings are identical, else 0). ` +
  'Few shared places pull it towards 0.5; `shared` is n.';

/**
 * Rows `(user_id, shared, match)` for every other member who rated at least one place I rated; `match` is null
 * below MIN_SHARED. Use as a subquery: `from (${taste(sql, me)}) t`.
 */
export function taste(sql: Sql, me: string) {
  return sql`
    with mine as (
      select place_id, overall::float8 as overall from ratings where user_id = ${me}
    ), pairs as (
      select r.user_id, count(*)::int as n, corr(m.overall, r.overall::float8) as r,
             bool_and(m.overall = r.overall) as same
      from ratings r join mine m using (place_id)
      where r.user_id <> ${me}
      group by r.user_id
    )
    select user_id, n as shared,
           case when n >= ${MIN_SHARED} then
             (0.5 + coalesce(r, case when same then 1 else 0 end) / 2 * n::float8 / (n + ${K}))::float8
           end as match
    from pairs
  `;
}

export const roundMatch = (m: number | null) => (m === null ? null : Math.round(m * 1000) / 1000);
