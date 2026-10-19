import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import type { Ctx } from './app.js';
import { monthStart } from './domain.js';
import { HttpError, invalidInput } from './errors.js';

const score = z.number().int().min(1).max(5);

/** A rating: vibe (klimat) and offer (oferta) required; service (obsługa) and value (wartość) null = nie dotyczy. */
export const ratingBody = z.object({
  vibe: score,
  offer: score,
  service: score.nullable().default(null),
  value: score.nullable().default(null),
  visited_on: z.iso
    .date()
    .nullable()
    .optional()
    .meta({
      description:
        'When I was there: YYYY-MM-DD, from `oldest_visit_date` in /meta (a year ago) to today; null clears it, left out keeps it',
    }),
  photo_ids: z
    .array(z.uuid())
    .default([])
    .meta({ description: 'Photos from POST /photos to add; required (min. 1) unless the rating already has photos' }),
});

/**
 * Attaches the person's uploaded photos to their rating of a place. Every rating has at least one photo and at
 * most maxPhotosPerRating. Call inside the transaction that writes the rating.
 */
export async function attachRatingPhotos(
  tx: TransactionSql,
  ctx: Ctx,
  placeId: string,
  userId: string,
  photoIds: string[],
): Promise<void> {
  const ids = [...new Set(photoIds)];
  if (ids.length) {
    const usable = await tx<{ id: string }[]>`
      select id from place_photos
      where id = any(${ids}::uuid[]) and uploaded_by = ${userId} and (place_id is null or place_id = ${placeId})
      for update
    `;
    if (usable.length !== ids.length) {
      throw invalidInput('photo_ids must be your own uploads, not attached to another place');
    }
    await tx`update place_photos set place_id = ${placeId} where id = any(${ids}::uuid[])`;
  }
  const [{ n }] = await tx<[{ n: number }]>`
    select count(*)::int as n from place_photos where place_id = ${placeId} and uploaded_by = ${userId}
  `;
  if (n === 0) throw invalidInput('A rating needs at least one photo: upload it with POST /photos and pass photo_ids');
  const max = await ctx.settings.get('maxPhotosPerRating');
  if (n > max) throw new HttpError(409, 'too_many_photos', `A rating can have at most ${max} photos`);
}

/** Awards this month's gold star. Atomic per person, so concurrent requests cannot exceed the monthly limit. */
export async function awardGoldStar(tx: TransactionSql, ctx: Ctx, placeId: string, userId: string): Promise<void> {
  const month = monthStart(ctx.now(), ctx.config.TIME_ZONE);
  await tx`select id from users where id = ${userId} for update`;
  const [already] = await tx`
    select 1 from stars where user_id = ${userId} and place_id = ${placeId} and month = ${month}::date
  `;
  if (already)
    throw new HttpError(409, 'gold_star_already_awarded', 'You already gave this place a gold star this month');
  const [{ used }] = await tx<[{ used: number }]>`
    select count(*)::int as used from stars where user_id = ${userId} and month = ${month}::date
  `;
  if (used >= (await ctx.settings.get('starsPerMonth'))) {
    throw new HttpError(409, 'no_gold_stars_left', 'No gold stars left this month');
  }
  await tx`insert into stars (user_id, place_id, month) values (${userId}, ${placeId}, ${month}::date)`;
}
