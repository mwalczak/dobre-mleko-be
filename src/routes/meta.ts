import type { App, Ctx } from '../app.js';
import { listCategories } from '../categories.js';
import { CRITERIA, oldestVisitDate } from '../domain.js';
import { Meta } from '../schemas.js';

export function metaRoutes(app: App, ctx: Ctx) {
  app.get(
    '/meta',
    {
      schema: {
        tags: ['Meta'],
        summary: 'Categories, rating criteria and limits',
        response: { 200: Meta },
      },
    },
    async () => {
      const [settings, categories] = await Promise.all([ctx.settings.all(), listCategories(ctx.sql)]);
      return {
        categories: categories.filter((c) => c.active).map((c) => c.id),
        category_details: categories,
        criteria: CRITERIA.map((c) => ({ ...c })),
        gold_stars_per_month: settings.starsPerMonth,
        max_photo_bytes: settings.maxPhotoBytes,
        max_photos_per_rating: settings.maxPhotosPerRating,
        time_zone: ctx.config.TIME_ZONE,
        oldest_visit_date: oldestVisitDate(ctx.now(), ctx.config.TIME_ZONE),
        google_web_client_id: ctx.config.GOOGLE_WEB_CLIENT_ID || null,
        dev_login: ctx.config.DEV_LOGIN && ctx.config.NODE_ENV !== 'production',
      };
    },
  );
}
