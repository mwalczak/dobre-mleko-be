import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(/[,\s]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  // Admins that always exist, so the dashboard can never lock everyone out. Everyone else is whitelisted in the
  // database from the admin dashboard (in dobre-mleko-web).
  ADMIN_EMAILS: csv,
  // OAuth client IDs (iOS, Android) whose Google ID tokens we accept.
  GOOGLE_CLIENT_IDS: csv,
  // OAuth client ID of type "Web application", used by the web app's and admin dashboard's Google sign-in button.
  GOOGLE_WEB_CLIENT_ID: z.string().trim().default(''),
  // Bundle ids of the iOS apps whose Sign in with Apple identity tokens we accept. Empty: APNS_APP_IDS.
  APPLE_CLIENT_IDS: csv,
  // Secret for signing our own session tokens. At least 32 characters.
  JWT_SECRET: z.string().min(32),
  // Enables POST /auth/dev for local development. Never honoured in production.
  DEV_LOGIN: z
    .string()
    .default('false')
    .transform((s) => s === 'true' || s === '1'),
  TIME_ZONE: z.string().default('Europe/Warsaw'),
  // Directory (a persistent volume in production) where photo files are stored.
  PHOTO_DIR: z.string().default('./data/photos'),
  CORS_ORIGINS: csv,
  // The web app's address: shared place links (/s/<token>) and their link previews point there.
  WEB_URL: z
    .string()
    .trim()
    .default('https://dobre-mleko.app')
    .transform((s) => s.replace(/\/+$/, '')),
  // Apple Push Notification service: the .p8 key (PEM, `\n` escapes accepted), its key id and the team id.
  // Without them push notifications are off (devices are still registered).
  APNS_KEY: z.string().default(''),
  APNS_KEY_ID: z.string().trim().default(''),
  APNS_TEAM_ID: z.string().trim().default(''),
  // App ids (bundle ids) iOS devices may register with — the APNs topics. Empty: any.
  APNS_APP_IDS: csv,
  // Firebase Cloud Messaging (Android): the service account's JSON key file contents. Without it Android devices
  // are registered but not sent to.
  FCM_SERVICE_ACCOUNT: z.string().default(''),
  // PMO, the issue tracker behind /reports: its URL, this app's key and the project. Empty: reporting is off.
  PMO_API_URL: z.string().trim().default(''),
  PMO_API_KEY: z.string().trim().default(''),
  PMO_PROJECT: z.string().trim().default('DM'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
