import type { Sql } from './db.js';
import { isOpenAt, RANKING_PRIOR_WEIGHT, type Category, type OpeningPeriod } from './domain.js';
import type { FileUrls } from './file-urls.js';
import type { CARD_COLORS } from './schemas.js';
import { toProfile, type ProfileJson } from './profiles.js';

export const PLACE_SORTS = ['best', 'gold_stars', 'nearest', 'newest', 'most_commented'] as const;
/** Public sorts plus `gold_stars_month`, used for the star of the month. */
export type PlaceSort = (typeof PLACE_SORTS)[number] | 'gold_stars_month';

export interface PlaceQuery {
  userId: string;
  month: string;
  starRankBonus: number;
  ids?: string[];
  q?: string;
  categories?: string[];
  minRating?: number;
  goldOnly?: boolean;
  tags?: string[];
  prices?: number[];
  near?: { lat: number; lng: number };
  radiusM?: number;
  /** Map viewport: only places inside this lng/lat rectangle. */
  bbox?: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  addedBy?: string;
  unratedOnly?: boolean;
  savedOnly?: boolean;
  includeClosed?: boolean;
  ratedOnly?: boolean;
  starredOnly?: boolean;
  sort?: PlaceSort;
  limit?: number;
  offset?: number;
}

export interface PlaceRow {
  id: string;
  name: string;
  category: Category;
  status: 'active' | 'temporarily_closed' | 'closed';
  price_level: number | null;
  address: string | null;
  description: string | null;
  lat: number;
  lng: number;
  tags: string[];
  opening_hours: OpeningPeriod[] | null;
  card_layout: 'auto' | 'a' | 'b' | 'c';
  photo_filter: 'none' | 'duotone' | 'halftone' | 'engraving' | 'riso';
  filter_intensity: number;
  card_color: (typeof CARD_COLORS)[number] | null;
  created_at: Date;
  updated_at: Date;
  author: ProfileJson;
  rating_avg: number | null;
  rating_count: number;
  gold_star_count: number;
  gold_stars_this_month: number;
  comment_count: number;
  rank_score: number;
  cover_id: string | null;
  cover_hash: string | null;
  cover_blurhash: string | null;
  cover_width: number | null;
  cover_height: number | null;
  distance_m: number | null;
  my_rating: number | null;
  is_saved: boolean;
  total: number;
}

/** Escapes LIKE wildcards in user input. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/**
 * Place cards with their aggregates: the one query behind search, the map, saved places and top lists.
 *
 * rank_score = v/(v+m)·R + m/(v+m)·C + bonus·gold_star_count (R place average, v its rating count, C the network
 * average, m = RANKING_PRIOR_WEIGHT). Gold stars never change the displayed average.
 */
export async function queryPlaces(sql: Sql, q: PlaceQuery): Promise<PlaceRow[]> {
  const near = q.near;
  // Distances use PostGIS geography (metres on the sphere) and the GiST index on geom::geography.
  const here = near ? sql`ST_SetSRID(ST_MakePoint(${near.lng}::float8, ${near.lat}::float8), 4326)::geography` : null;
  const distance = here ? sql`ST_Distance(p.geom::geography, ${here})` : sql`null::float8`;
  const box = q.bbox;
  const search = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
  const m = RANKING_PRIOR_WEIGHT;

  const order = {
    best: sql`rank_score desc, p.created_at desc`,
    gold_stars: sql`gold_star_count desc, rank_score desc`,
    gold_stars_month: sql`gold_stars_this_month desc, gold_star_count desc, rank_score desc`,
    nearest: here ? sql`p.geom::geography <-> ${here}` : sql`rank_score desc`,
    newest: sql`p.created_at desc`,
    most_commented: sql`comment_count desc, rank_score desc`,
  }[q.sort ?? 'best'];

  return sql<PlaceRow[]>`
    with agg as (
      select place_id, avg(overall)::numeric(4, 2) as avg, count(*)::int as n from ratings group by place_id
    ), st as (
      select place_id, count(*)::int as total, (count(*) filter (where month = ${q.month}::date))::int as this_month
      from stars group by place_id
    ), cm as (
      select place_id, count(*)::int as n from comments group by place_id
    ), prior as (
      select coalesce(avg(overall), 0)::float8 as c from ratings
    ), scored as (
      select
        p.*,
        agg.avg as rating_avg,
        coalesce(agg.n, 0) as rating_count,
        coalesce(st.total, 0) as gold_star_count,
        coalesce(st.this_month, 0) as gold_stars_this_month,
        coalesce(cm.n, 0) as comment_count,
        (coalesce(agg.n, 0) * coalesce(agg.avg, 0) + ${m} * prior.c) / (coalesce(agg.n, 0) + ${m})::float8
          + ${q.starRankBonus}::float8 * coalesce(st.total, 0) as rank_score
      from places p
      left join agg on agg.place_id = p.id
      left join st on st.place_id = p.id
      left join cm on cm.place_id = p.id
      cross join prior
    )
    select
      p.id, p.name, p.category, p.status, p.price_level, p.address, p.description, p.lat, p.lng, p.tags,
      p.opening_hours, p.created_at, p.updated_at, p.card_layout, p.photo_filter, p.filter_intensity, p.card_color,
      profile_json(u) as author,
      p.rating_avg, p.rating_count, p.gold_star_count, p.gold_stars_this_month, p.comment_count, p.rank_score,
      cover.id as cover_id, cover.hash as cover_hash, cover.blurhash as cover_blurhash,
      cover.width as cover_width, cover.height as cover_height,
      ${distance} as distance_m,
      (select r.overall from ratings r where r.place_id = p.id and r.user_id = ${q.userId}) as my_rating,
      exists (select 1 from saved_places sp where sp.user_id = ${q.userId} and sp.place_id = p.id) as is_saved,
      (count(*) over ())::int as total
    from scored p
    join users u on u.id = p.added_by
    left join lateral (
      select ph.id, ph.hash, ph.blurhash, ph.width, ph.height from place_photos ph
      where ph.place_id = p.id order by ph.position nulls last, ph.created_at, ph.id limit 1
    ) cover on true
    where true
      ${q.ids ? sql`and p.id = any(${q.ids}::uuid[])` : sql``}
      ${q.includeClosed || q.ids ? sql`` : sql`and p.status <> 'closed'`}
      ${search ? sql`and p.search_text like f_unaccent(lower(${search}))` : sql``}
      ${q.categories?.length ? sql`and p.category = any(${q.categories})` : sql``}
      ${q.minRating ? sql`and p.rating_avg >= ${q.minRating}` : sql``}
      ${q.goldOnly ? sql`and p.gold_star_count > 0` : sql``}
      ${q.tags?.length ? sql`and p.tags && ${q.tags}::text[]` : sql``}
      ${q.prices?.length ? sql`and p.price_level = any(${q.prices}::int[])` : sql``}
      ${here && q.radiusM != null ? sql`and ST_DWithin(p.geom::geography, ${here}, ${q.radiusM})` : sql``}
      ${box ? sql`and p.geom && ST_MakeEnvelope(${box.minLng}, ${box.minLat}, ${box.maxLng}, ${box.maxLat}, 4326)` : sql``}
      ${q.addedBy ? sql`and p.added_by = ${q.addedBy}` : sql``}
      ${q.unratedOnly ? sql`and not exists (select 1 from ratings r where r.place_id = p.id and r.user_id = ${q.userId})` : sql``}
      ${q.savedOnly ? sql`and exists (select 1 from saved_places sp where sp.user_id = ${q.userId} and sp.place_id = p.id)` : sql``}
      ${q.ratedOnly ? sql`and p.rating_count > 0` : sql``}
      ${q.starredOnly ? sql`and p.gold_star_count > 0` : sql``}
    order by ${order}, p.id
    limit ${q.limit ?? 30} offset ${q.offset ?? 0}
  `;
}

export function toPhoto(
  p: { id: string; hash: string; blurhash: string | null; width: number | null; height: number | null },
  urls: FileUrls,
) {
  return {
    id: p.id,
    url: urls.url(p.hash),
    thumb_url: urls.url(p.hash, 'thumb'),
    blurhash: p.blurhash,
    width: p.width,
    height: p.height,
  };
}

export function toPlaceSummary(row: PlaceRow, ctx: { timeZone: string; now: Date; urls: FileUrls }) {
  return {
    id: row.id,
    name: row.name,
    category_id: row.category,
    status: row.status,
    price_level: row.price_level,
    address: row.address,
    description: row.description,
    location: { lat: row.lat, lng: row.lng },
    tags: row.tags,
    open_now: row.opening_hours ? isOpenAt(row.opening_hours, ctx.now, ctx.timeZone) : null,
    rating_avg: row.rating_avg,
    rating_count: row.rating_count,
    gold_star_count: row.gold_star_count,
    gold_stars_this_month: row.gold_stars_this_month,
    comment_count: row.comment_count,
    rank_score: Math.round(row.rank_score * 1000) / 1000,
    cover_photo:
      row.cover_id && row.cover_hash
        ? toPhoto(
            {
              id: row.cover_id,
              hash: row.cover_hash,
              blurhash: row.cover_blurhash,
              width: row.cover_width,
              height: row.cover_height,
            },
            ctx.urls,
          )
        : null,
    distance_m: row.distance_m == null ? null : Math.round(row.distance_m),
    author: toProfile(row.author, ctx.urls),
    my_rating: row.my_rating,
    is_saved: row.is_saved,
    card_style: {
      layout: row.card_layout,
      photo_filter: row.photo_filter,
      filter_intensity: row.filter_intensity,
      color: row.card_color,
    },
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
