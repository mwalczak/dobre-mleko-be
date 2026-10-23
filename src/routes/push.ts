import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { requireCategories } from '../categories.js';
import { invalidInput } from '../errors.js';
import { sendAdminMessage, toNotificationPrefs, type Audience, type NotifyColumns } from '../notifications.js';
import { toProfile, type ProfileJson } from '../profiles.js';
import type { PushKind } from '../push.js';
import { PushCounts, PushLog, PushOverview } from '../schemas.js';

const token = z.string().trim().min(16).max(512);
const device = z.object({
  token: token.meta({ description: 'APNs device token (hex) or FCM registration token' }),
  platform: z.enum(['ios', 'android']),
  environment: z.enum(['sandbox', 'production']).meta({
    description: 'APNs environment: `sandbox` for development-signed builds, `production` otherwise (Android: ignored)',
  }),
  app_id: z.string().trim().min(1).max(200).meta({ description: 'Bundle id / package name (the APNs topic on iOS)' }),
});

const audience = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('all') }),
    z.object({ kind: z.literal('users'), user_ids: z.array(z.uuid()).min(1).max(500) }),
    z.object({ kind: z.literal('categories'), categories: z.array(z.string().min(1)).min(1).max(50) }),
  ])
  .meta({
    description:
      'Everyone (`all`), chosen people (`users`), or people with any of the `categories` among their favourites',
  });

type DeviceRow = {
  user_id: string;
  platform: 'ios' | 'android';
  environment: 'sandbox' | 'production';
  app_id: string;
  created_at: Date;
  last_seen_at: Date;
};

/** Devices for push notifications (the apps) and the admin's view of who gets them, with sending. */
export function pushRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;

  app.put(
    '/me/devices',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Register a device for push notifications',
        description:
          'Call after the system gives the app a token (every launch is fine). A token moves to the signed-in ' +
          'person if someone else used the device before. 422 for an iOS app id the server does not send to.',
        body: device,
      },
    },
    async (req, reply) => {
      const b = req.body;
      // Only iOS app ids are listed (the APNs topics); an Android token belongs to the Firebase project anyway.
      if (b.platform === 'ios' && config.APNS_APP_IDS.length && !config.APNS_APP_IDS.includes(b.app_id.toLowerCase())) {
        throw invalidInput(`Unknown app id: ${b.app_id}`);
      }
      await sql`
        insert into devices (token, user_id, platform, environment, app_id)
        values (${b.token}, ${req.user.id}, ${b.platform}, ${b.environment}, ${b.app_id})
        on conflict (token) do update set
          user_id = excluded.user_id, platform = excluded.platform, environment = excluded.environment,
          app_id = excluded.app_id, last_seen_at = now()
      `;
      return reply.status(204).send();
    },
  );

  app.delete(
    '/me/devices/:token',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Unregister a device',
        description: 'On sign-out, or when the person turns notifications off. Unknown tokens are fine.',
        params: z.object({ token }),
      },
    },
    async (req, reply) => {
      await sql`delete from devices where token = ${req.params.token} and user_id = ${req.user.id}`;
      return reply.status(204).send();
    },
  );

  app.get(
    '/admin/push',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Push notifications: who gets them',
        description:
          'Every active member with their notification settings and devices, and whether APNs or FCM is set up.',
        response: { 200: PushOverview },
      },
    },
    async () => {
      const members = await sql<
        ({
          id: string;
          profile: ProfileJson;
          email: string;
        } & NotifyColumns)[]
      >`
        select u.id, profile_json(u) as profile, u.email, u.notify_new_places, u.notify_comments,
          u.notify_gold_stars, u.notify_joins
        from users u where u.status = 'active'
        order by lower(u.name)
      `;
      const devices = await sql<DeviceRow[]>`
        select user_id, platform, environment, app_id, created_at, last_seen_at from devices
        order by last_seen_at desc
      `;
      return {
        configured: ctx.notifier.sender.configured,
        members: members.map((m) => ({
          profile: toProfile(m.profile, ctx.urls),
          email: m.email,
          notifications: toNotificationPrefs(m),
          devices: devices
            .filter((d) => d.user_id === m.id)
            .map(({ user_id: _, created_at, last_seen_at, ...d }) => ({
              ...d,
              created_at: created_at.toISOString(),
              last_seen_at: last_seen_at.toISOString(),
            })),
        })),
      };
    },
  );

  app.post(
    '/admin/push',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Send a push notification',
        description:
          'To everyone, chosen people, or people with chosen favourite categories — on all their devices. ' +
          '`place_id` opens that place when tapped. Waits for APNs and FCM and returns the counts (all failed when push is ' +
          'not configured).',
        body: z.object({
          audience,
          title: z.string().trim().min(1).max(120),
          body: z.string().trim().min(1).max(500),
          place_id: z.uuid().nullable().optional(),
        }),
        response: { 200: PushCounts },
      },
    },
    async (req) => {
      const b = req.body;
      if (b.audience.kind === 'categories') await requireCategories(sql, b.audience.categories);
      if (b.place_id) {
        const [place] = await sql`select 1 from places where id = ${b.place_id}`;
        if (!place) throw invalidInput('Unknown place');
      }
      return sendAdminMessage(
        ctx,
        b.audience as Audience,
        { title: b.title, body: b.body, placeId: b.place_id ?? null },
        req.user.id,
      );
    },
  );

  app.get(
    '/admin/push/log',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Sent push notifications',
        description: 'The latest notifications: new places, comments and admin messages, newest first.',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: PushLog },
      },
    },
    async (req) => {
      const rows = await sql<
        {
          id: string;
          created_at: Date;
          kind: PushKind;
          title: string;
          body: string;
          place_id: string | null;
          audience: Record<string, unknown>;
          recipients: number;
          devices: number;
          delivered: number;
          failed: number;
          sender_id: string | null;
          sender_name: string | null;
        }[]
      >`
        select l.id, l.created_at, l.kind, l.title, l.body, l.place_id, l.audience, l.recipients, l.devices,
               l.delivered, l.failed, u.id as sender_id, u.name as sender_name
        from push_log l left join users u on u.id = l.sent_by
        order by l.created_at desc
        limit ${req.query.limit}
      `;
      return {
        items: rows.map(({ sender_id, sender_name, created_at, ...r }) => ({
          ...r,
          created_at: created_at.toISOString(),
          sent_by: sender_id ? { id: sender_id, display_name: sender_name! } : null,
        })),
      };
    },
  );
}
