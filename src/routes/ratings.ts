import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { monthStart } from '../domain.js';
import { HttpError, notFound } from '../errors.js';
import { releaseFiles } from '../photo-store.js';
import { placeAuthor } from '../place-access.js';
import { attachRatingPhotos, awardGoldStar, ratingBody } from '../rating-logic.js';
import { GoldStarResult, PlaceDetail } from '../schemas.js';
import { starsLeft } from './me.js';
import { checkVisitedOn } from './wishlist.js';
import { loadPlace } from './places.js';

const idParams = z.object({ id: z.uuid() });

export function ratingRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;

  app.put(
    '/places/:id/rating',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Ratings'],
        summary: 'Rate a place (or change my rating)',
        description:
          'Scores 1–5. `vibe` (klimat) and `offer` (oferta) are required; `service` (obsługa) and `value` ' +
          '(wartość) may be null or left out ("nie dotyczy"). Overall = average of the given scores. `visited_on` ' +
          '(optional) is when I was there. Every rating ' +
          'has at least one photo: upload with `POST /photos`, then pass `photo_ids` (added to the ones the rating ' +
          'already has; up to `max_photos_per_rating`).',
        params: idParams,
        body: ratingBody,
        response: { 200: PlaceDetail },
      },
    },
    async (req) => {
      await placeAuthor(ctx, req.params.id);
      const { vibe, offer, service, value, visited_on, photo_ids } = req.body;
      checkVisitedOn(ctx, visited_on);
      const keepVisited = visited_on === undefined;
      await sql.begin(async (tx) => {
        await tx`
          insert into ratings (user_id, place_id, vibe, offer, service, value, visited_on)
          values (${req.user.id}, ${req.params.id}, ${vibe}, ${offer}, ${service}, ${value}, ${visited_on ?? null})
          on conflict (user_id, place_id) do update set
            vibe = excluded.vibe, offer = excluded.offer, service = excluded.service, value = excluded.value,
            visited_on = case when ${keepVisited} then ratings.visited_on else excluded.visited_on end,
            updated_at = now()
        `;
        await attachRatingPhotos(tx, ctx, req.params.id, req.user.id, photo_ids);
      });
      return loadPlace(ctx, req.params.id, req.user.id);
    },
  );

  app.delete(
    '/places/:id/rating',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Ratings'],
        summary: 'Remove my rating',
        description: 'Also removes the photos that belong to it.',
        params: idParams,
        response: { 200: PlaceDetail },
      },
    },
    async (req) => {
      await placeAuthor(ctx, req.params.id);
      await sql.begin(async (tx) => {
        await tx`delete from ratings where user_id = ${req.user.id} and place_id = ${req.params.id}`;
        const photos = await tx<{ hash: string }[]>`
          delete from place_photos where place_id = ${req.params.id} and uploaded_by = ${req.user.id} returning hash
        `;
        await releaseFiles(
          tx,
          ctx.photos,
          photos.map((p) => p.hash),
        );
      });
      return loadPlace(ctx, req.params.id, req.user.id);
    },
  );

  app.post(
    '/places/:id/gold-star',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Ratings'],
        summary: 'Give a gold star',
        description:
          '"Musisz tam iść". Does not change the displayed average but adds to rank_score. `gold_stars_per_month` ' +
          '(see /meta) per person per calendar month (Europe/Warsaw), once per place per month. 409 ' +
          '`no_gold_stars_left`, `gold_star_already_awarded`.',
        params: idParams,
        response: { 200: GoldStarResult },
      },
    },
    async (req) => {
      await placeAuthor(ctx, req.params.id);
      await sql.begin((tx) => awardGoldStar(tx, ctx, req.params.id, req.user.id));
      const month = monthStart(ctx.now(), config.TIME_ZONE);
      return { awarded: true, gold_stars_left: await starsLeft(ctx, req.user.id, month) };
    },
  );

  app.delete(
    '/places/:id/gold-star',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Ratings'],
        summary: 'Take back my gold star',
        description:
          'Only during the month it was given; it returns to the quota. 409 `gold_star_revoke_window_passed` for a ' +
          'star from an earlier month, 404 when there is none.',
        params: idParams,
        response: { 200: GoldStarResult },
      },
    },
    async (req) => {
      const month = monthStart(ctx.now(), config.TIME_ZONE);
      const removed = await sql`
        delete from stars where user_id = ${req.user.id} and place_id = ${req.params.id} and month = ${month}::date
        returning 1
      `;
      if (!removed.length) {
        const [earlier] = await sql`select 1 from stars where user_id = ${req.user.id} and place_id = ${req.params.id}`;
        if (earlier) {
          throw new HttpError(
            409,
            'gold_star_revoke_window_passed',
            'Gold stars can only be taken back in their month',
          );
        }
        throw notFound('Gold star');
      }
      return { awarded: false, gold_stars_left: await starsLeft(ctx, req.user.id, month) };
    },
  );
}
