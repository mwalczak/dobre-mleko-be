import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type preHandlerHookHandler,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import {
  createAppleVerifier,
  createGoogleVerifier,
  requireAdmin,
  requireUser,
  Sessions,
  type AppleVerifier,
  type GoogleVerifier,
} from './auth.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { HttpError } from './errors.js';
import { FileUrls } from './file-urls.js';
import { PhotoStore } from './photo-store.js';
import { Pmo } from './pmo.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { categoryRoutes } from './routes/categories.js';
import { iconRoutes } from './routes/icons.js';
import { pushRoutes } from './routes/push.js';
import { commentRoutes } from './routes/comments.js';
import { meRoutes } from './routes/me.js';
import { memberRoutes } from './routes/members.js';
import { mapsLinkRoutes } from './routes/maps-links.js';
import { metaRoutes } from './routes/meta.js';
import { tagRoutes } from './routes/tags.js';
import { photoRoutes } from './routes/photos.js';
import { placeRoutes } from './routes/places.js';
import { ratingRoutes } from './routes/ratings.js';
import { reportRoutes } from './routes/reports.js';
import { shareRoutes } from './routes/shares.js';
import { statsRoutes } from './routes/stats.js';
import { wishlistRoutes } from './routes/wishlist.js';
import { ErrorBody } from './schemas.js';
import { PHOTO_BYTES_CEILING, Settings } from './settings.js';
import {
  ApnsSender,
  DisabledPushSender,
  FcmSender,
  Notifier,
  PlatformPushSender,
  type FcmCredentials,
  type PushSender,
} from './push.js';

export interface AppDeps {
  config: Config;
  sql: Sql;
  verifyGoogle?: GoogleVerifier;
  verifyApple?: AppleVerifier;
  now?: () => Date;
  logger?: boolean;
  /** How long settings are cached (default 10 s). */
  settingsCacheMs?: number;
  /** Push sender (tests); by default APNs when configured. */
  pushSender?: PushSender;
  /** Fetch for following Google Maps short links (tests). */
  fetchMapsLink?: typeof fetch;
  /** Fetch for calls to PMO, the issue tracker (tests). */
  fetchPmo?: typeof fetch;
}

export interface Ctx {
  config: Config;
  sql: Sql;
  sessions: Sessions;
  verifyGoogle: GoogleVerifier;
  verifyApple: AppleVerifier;
  /** Signed-in and whitelisted. */
  auth: preHandlerHookHandler;
  /** Signed-in, whitelisted admin. */
  admin: preHandlerHookHandler;
  settings: Settings;
  photos: PhotoStore;
  /** Signs photo and avatar URLs. */
  urls: FileUrls;
  /** Push notifications to people's devices. */
  notifier: Notifier;
  /** Follows Google Maps short links. */
  fetchMapsLink: typeof fetch;
  /** The issue tracker behind /reports. */
  pmo: Pmo;
  now: () => Date;
}

/** What place and profile mappers need to render a response. */
export const view = (ctx: Ctx) => ({ timeZone: ctx.config.TIME_ZONE, now: ctx.now(), urls: ctx.urls });

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/**
 * APNs for iOS when the key, key id and team id are set, FCM for Android with a service account; a platform
 * without credentials gets no notifications.
 */
function pushSender(config: Config): PushSender {
  const apns =
    config.APNS_KEY && config.APNS_KEY_ID && config.APNS_TEAM_ID
      ? new ApnsSender({ key: config.APNS_KEY, keyId: config.APNS_KEY_ID, teamId: config.APNS_TEAM_ID })
      : new DisabledPushSender();
  const fcm = fcmCredentials(config.FCM_SERVICE_ACCOUNT);
  return new PlatformPushSender({ ios: apns, android: fcm ? new FcmSender(fcm) : new DisabledPushSender() });
}

/** The fields FCM needs from a service account key file; null when it is not set. */
export function fcmCredentials(json: string): FcmCredentials | null {
  if (!json.trim()) return null;
  const key = JSON.parse(json) as { project_id?: string; client_email?: string; private_key?: string };
  if (!key.project_id || !key.client_email || !key.private_key) {
    throw new Error('FCM_SERVICE_ACCOUNT: expected project_id, client_email and private_key');
  }
  return { projectId: key.project_id, clientEmail: key.client_email, privateKey: key.private_key };
}

export async function buildApp(deps: AppDeps) {
  const { config, sql } = deps;
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1024 * 1024 }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false });
  // The effective size limit is the maxPhotoBytes setting, applied per upload.
  await app.register(multipart, { limits: { fileSize: PHOTO_BYTES_CEILING, files: 1 } });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Dobre Mleko API',
        version: '1',
        description: [
          'Place ratings for friends only. Only Google accounts on the server whitelist can sign in.',
          '',
          '**Signing in:** the app signs in with Google, sends the Google ID token to `POST /auth/google` and gets a',
          'session token back. Send it on every other request as `Authorization: Bearer <token>`. When',
          '`has_profile` is false, the app shows onboarding and finishes it with `POST /me/profile`.',
          '',
          '**Conventions:** JSON in snake_case, dates in ISO 8601 (UTC), ids are UUID strings. Lists are paginated',
          "with `limit` and `cursor`; pass the response's `next_cursor` to get the next page.",
          '',
          '**Errors** look like `{"error": "not_authorized", "message": "..."}`. Codes: `not_authenticated` (401,',
          'sign in again), `not_authorized` (403), `not_found` (404), `invalid_input` (422), `no_gold_stars_left`,',
          '`gold_star_already_awarded`, `rating_needs_photo` and other conflicts (409).',
          '',
          '**Photos** are private: their URLs are signed and expire after 12–24 h, so always use the URLs from the',
          'latest response.',
        ].join('\n'),
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, ...err.extra });
    }
    const e = err as { validation?: unknown; statusCode?: number; code?: string; message: string };
    if (e.validation) return reply.status(422).send({ error: 'invalid_input', message: e.message });
    if (e.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.status(413).send({ error: 'file_too_large', message: e.message });
    if (e.statusCode && e.statusCode < 500) {
      const code = e.statusCode === 400 || e.statusCode === 415 ? 'invalid_input' : 'bad_request';
      return reply.status(e.statusCode).send({ error: code, message: e.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Not found' }));

  const sessions = new Sessions(config);
  const auth = requireUser({ sessions, sql });
  const now = deps.now ?? (() => new Date());
  const ctx: Ctx = {
    config,
    sql,
    sessions,
    verifyGoogle:
      deps.verifyGoogle ??
      createGoogleVerifier([...config.GOOGLE_CLIENT_IDS, config.GOOGLE_WEB_CLIENT_ID].filter(Boolean)),
    verifyApple:
      deps.verifyApple ??
      createAppleVerifier(config.APPLE_CLIENT_IDS.length ? config.APPLE_CLIENT_IDS : config.APNS_APP_IDS),
    auth,
    admin: requireAdmin(auth),
    settings: new Settings(sql, deps.settingsCacheMs),
    photos: new PhotoStore(config.PHOTO_DIR),
    urls: new FileUrls(config.JWT_SECRET, now),
    notifier: new Notifier(sql, deps.pushSender ?? pushSender(config), (error) =>
      app.log.error({ err: error }, 'push notification failed'),
    ),
    fetchMapsLink: deps.fetchMapsLink ?? fetch,
    pmo: new Pmo({
      url: config.PMO_API_URL,
      key: config.PMO_API_KEY,
      project: config.PMO_PROJECT,
      fetch: deps.fetchPmo ?? fetch,
    }),
    now,
  };
  app.addHook('onClose', async () => {
    await ctx.notifier.settle();
    ctx.notifier.sender.close();
  });

  // Every documented route shares the error shape; signed-in routes are marked as needing the bearer token.
  app.addHook('onRoute', (route) => {
    if (!route.schema || route.schema.hide) return;
    const schema = route.schema as Record<string, unknown>;
    schema.response = { ...(schema.response as object), '4xx': ErrorBody };
    schema.security = route.preHandler === ctx.auth || route.preHandler === ctx.admin ? [{ bearerAuth: [] }] : [];
  });

  app.get('/healthz', { schema: { hide: true } }, async () => {
    await sql`select 1`;
    return { ok: true };
  });

  for (const routes of [
    metaRoutes,
    tagRoutes,
    mapsLinkRoutes,
    authRoutes,
    meRoutes,
    memberRoutes,
    placeRoutes,
    ratingRoutes,
    wishlistRoutes,
    commentRoutes,
    photoRoutes,
    statsRoutes,
    adminRoutes,
    categoryRoutes,
    iconRoutes,
    pushRoutes,
    reportRoutes,
    shareRoutes,
  ]) {
    routes(app, ctx);
  }

  // `settle`: waits for the notifications still being sent after their responses (tests, before cleaning up).
  return Object.assign(app, { settle: () => ctx.notifier.settle() });
}
