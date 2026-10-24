import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { HttpError, notFound } from '../errors.js';
import { notifyJoinRequest } from '../notifications.js';
import { placeAuthor } from '../place-access.js';
import { JoinRequestOverview, JoinRequestResult, PlaceShare, SharePreview } from '../schemas.js';

const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/) });
const idParams = z.object({ id: z.uuid() });

/** Pending requests at once: a cap against someone filling the admins' list from the public form. */
const MAX_PENDING = 200;

interface ShareRow {
  token: string;
  place_id: string;
  name: string;
  category: string;
  category_label: string | null;
  address: string | null;
  rating_avg: number | null;
  rating_count: number;
  gold_star_count: number;
  cover_hash: string | null;
  cover_width: number | null;
  cover_height: number | null;
  sharer_id: string;
  sharer_name: string;
  sharer_badge: string | null;
  sharer_rating: number | null;
}

interface JoinRequestRow {
  id: string;
  email: string;
  name: string;
  status: 'pending' | 'accepted' | 'dismissed';
  created_at: Date;
  handled_at: Date | null;
  referrer_id: string | null;
  referrer_name: string | null;
  place_id: string | null;
  place_name: string | null;
  joined: boolean;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "4,5" — Polish decimal comma, like the apps. */
const plRating = (n: number) => n.toFixed(1).replace('.', ',');

/**
 * Sharing places (DM-45). A member gets one link per place; anyone with it sees a public preview of that place only
 * (GET /shares/:token, its cover, and an HTML page with Open Graph tags for Messenger and WhatsApp link previews) and
 * can ask to join (POST /join-requests). Admins put the e-mail on the list from /admin/join-requests.
 */
export function shareRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;
  const shareUrl = (token: string) => `${config.WEB_URL}/s/${token}`;
  const coverUrl = (token: string) => `${config.WEB_URL}/api/shares/${token}/cover`;

  /** A share whose place still exists, is not closed, and whose author of the link is still a member. */
  async function loadShare(token: string): Promise<ShareRow> {
    const [row] = await sql<ShareRow[]>`
      select s.token, p.id as place_id, p.name, p.category, c.label as category_label, p.address,
             (select avg(r.overall)::float8 from ratings r where r.place_id = p.id) as rating_avg,
             (select count(*)::int from ratings r where r.place_id = p.id) as rating_count,
             (select count(*)::int from stars st where st.place_id = p.id) as gold_star_count,
             cover.hash as cover_hash, cover.width as cover_width, cover.height as cover_height,
             u.id as sharer_id, u.name as sharer_name, u.badge as sharer_badge,
             (select r.overall::float8 from ratings r where r.place_id = p.id and r.user_id = u.id) as sharer_rating
      from place_shares s
      join places p on p.id = s.place_id
      join users u on u.id = s.shared_by
      left join categories c on c.id = p.category
      left join lateral (
        select ph.hash, ph.width, ph.height from place_photos ph
        where ph.place_id = p.id order by ph.position nulls last, ph.created_at, ph.id limit 1
      ) cover on true
      where s.token = ${token} and p.status <> 'closed' and u.status = 'active'
    `;
    if (!row) throw notFound('Share');
    return row;
  }

  app.post(
    '/places/:id/shares',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Sharing'],
        summary: 'Get my link to share a place',
        description:
          'The same link for the same member and place each time. Anyone with it sees a preview of this place ' +
          '(GET /shares/{token}) and can ask to join; the apps put it in the system share sheet with a short text.',
        params: idParams,
        response: { 200: PlaceShare },
      },
    },
    async (req) => {
      await placeAuthor(ctx, req.params.id);
      const [row] = await sql<{ token: string }[]>`
        insert into place_shares (token, place_id, shared_by)
        values (${randomBytes(9).toString('base64url')}, ${req.params.id}, ${req.user.id})
        on conflict (place_id, shared_by) do update set place_id = excluded.place_id
        returning token
      `;
      return { token: row!.token, url: shareUrl(row!.token) };
    },
  );

  app.get(
    '/shares/:token',
    {
      schema: {
        tags: ['Sharing'],
        summary: 'Preview of a shared place (public)',
        description: 'No sign-in. 404 when the place is closed or gone, or the member who shared it left.',
        params: tokenParams,
        response: { 200: SharePreview },
      },
    },
    async (req) => {
      const s = await loadShare(req.params.token);
      return {
        token: s.token,
        place: {
          id: s.place_id,
          name: s.name,
          category_id: s.category,
          category_label: s.category_label ?? s.category,
          address: s.address,
          rating_avg: s.rating_avg == null ? null : Math.round(s.rating_avg * 100) / 100,
          rating_count: s.rating_count,
          gold_star_count: s.gold_star_count,
          cover_url: s.cover_hash ? coverUrl(s.token) : null,
          cover_width: s.cover_width,
          cover_height: s.cover_height,
        },
        shared_by: { display_name: s.sharer_name, badge: s.sharer_badge, rating: s.sharer_rating },
      };
    },
  );

  app.post(
    '/shares/:token/open',
    {
      schema: {
        tags: ['Sharing'],
        summary: 'Count an opened link (public)',
        description: 'The web page calls it once per visit; link-preview bots do not, so it counts people.',
        params: tokenParams,
      },
    },
    async (req, reply) => {
      await sql`update place_shares set opens = opens + 1 where token = ${req.params.token}`;
      return reply.status(204).send();
    },
  );

  app.get(
    '/shares/:token/cover',
    { schema: { tags: ['Sharing'], summary: "The shared place's cover image (public)", params: tokenParams } },
    async (req, reply) => {
      const s = await loadShare(req.params.token);
      if (!s.cover_hash || !(await ctx.photos.exists(s.cover_hash, 'full'))) throw notFound('Cover');
      return reply
        .header('content-type', (await ctx.photos.sniff(s.cover_hash)) ?? 'application/octet-stream')
        .header('cache-control', 'public, max-age=86400')
        .send(ctx.photos.read(s.cover_hash, 'full'));
    },
  );

  app.get(
    '/shares/:token/og',
    {
      schema: {
        tags: ['Sharing'],
        summary: 'Link preview page (public)',
        description:
          "A small HTML page with Open Graph tags. The web app's nginx sends link-preview bots (Messenger, " +
          'WhatsApp, …) here for /s/{token}; people get the web app.',
        params: tokenParams,
      },
    },
    async (req, reply) => {
      const s = await loadShare(req.params.token);
      const title = `${s.name} — poleca ${s.sharer_name}`;
      const rating = s.rating_avg == null ? null : `${plRating(s.rating_avg)}/5`;
      const description = [
        s.category_label ?? s.category,
        rating && `ocena ${rating}`,
        'Dobre Mleko — przyjaciele polecają sobie miejsca',
      ]
        .filter(Boolean)
        .join(' · ');
      const meta = [
        ['og:type', 'website'],
        ['og:site_name', 'Dobre Mleko'],
        ['og:locale', 'pl_PL'],
        ['og:title', title],
        ['og:description', description],
        ['og:url', shareUrl(s.token)],
        ...(s.cover_hash
          ? [
              ['og:image', coverUrl(s.token)],
              ...(s.cover_width && s.cover_height
                ? [
                    ['og:image:width', String(s.cover_width)],
                    ['og:image:height', String(s.cover_height)],
                  ]
                : []),
              ['og:image:alt', s.name],
            ]
          : []),
      ]
        .map(([k, v]) => `<meta property="${k}" content="${escapeHtml(v!)}">`)
        .join('\n');
      const card = s.cover_hash ? 'summary_large_image' : 'summary';
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'public, max-age=600')
        .send(
          `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>\n` +
            `<meta name="description" content="${escapeHtml(description)}">\n${meta}\n` +
            `<meta name="twitter:card" content="${card}">\n</head><body><h1>${escapeHtml(title)}</h1>` +
            `<p>${escapeHtml(description)}</p><p><a href="${escapeHtml(shareUrl(s.token))}">Otwórz</a></p></body></html>`,
        );
    },
  );

  app.post(
    '/join-requests',
    {
      schema: {
        tags: ['Sharing'],
        summary: 'Ask to join (public)',
        description:
          "From a shared link's page: the e-mail of the Google or Apple account and a name. Admins get a push " +
          'notification and put the e-mail on the list from the dashboard. An e-mail already on the list gets ' +
          '`allowed` (sign in); asking again while pending updates the request. 429 `too_many_requests` when ' +
          `${MAX_PENDING} requests are already waiting.`,
        body: z.object({
          email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
          name: z.string().trim().min(1).max(60),
          share_token: z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,32}$/)
            .nullable()
            .default(null),
        }),
        response: { 200: JoinRequestResult },
      },
    },
    async (req) => {
      const b = req.body;
      const [allowed] = await sql`select 1 from allowed_emails where email = ${b.email}`;
      if (allowed) return { status: 'allowed' as const };
      const [share] = b.share_token
        ? await sql<{ token: string; place_id: string; shared_by: string }[]>`
            select token, place_id, shared_by from place_shares where token = ${b.share_token}
          `
        : [];
      const [{ n }] = await sql<[{ n: number }]>`select count(*)::int as n from join_requests where status = 'pending'`;
      const [existing] = await sql<{ id: string }[]>`
        select id from join_requests where email = ${b.email} and status = 'pending'
      `;
      if (!existing && n >= MAX_PENDING) throw new HttpError(429, 'too_many_requests', 'Too many requests waiting');
      const [row] = await sql<{ id: string; inserted: boolean }[]>`
        insert into join_requests (email, name, share_token, referred_by, place_id)
        values (${b.email}, ${b.name}, ${share?.token ?? null}, ${share?.shared_by ?? null}, ${share?.place_id ?? null})
        on conflict (email) where status = 'pending' do update set
          name = excluded.name,
          share_token = coalesce(excluded.share_token, join_requests.share_token),
          referred_by = coalesce(excluded.referred_by, join_requests.referred_by),
          place_id = coalesce(excluded.place_id, join_requests.place_id)
        returning id, (xmax = 0) as inserted
      `;
      if (row!.inserted) notifyJoinRequest(ctx, row!.id);
      return { status: 'pending' as const };
    },
  );

  const selectRequests = (where: ReturnType<typeof sql>) => sql<JoinRequestRow[]>`
    select j.id, j.email, j.name, j.status, j.created_at, j.handled_at,
           r.id as referrer_id, r.name as referrer_name, p.id as place_id, p.name as place_name,
           exists (select 1 from users u where u.email = j.email and u.profile_completed_at is not null) as joined
    from join_requests j
    left join users r on r.id = j.referred_by
    left join places p on p.id = j.place_id
    ${where}
  `;
  const toRequest = (j: JoinRequestRow) => ({
    id: j.id,
    email: j.email,
    name: j.name,
    status: j.status,
    created_at: j.created_at.toISOString(),
    referred_by: j.referrer_id ? { id: j.referrer_id, display_name: j.referrer_name! } : null,
    place: j.place_id ? { id: j.place_id, name: j.place_name! } : null,
    handled_at: j.handled_at?.toISOString() ?? null,
    joined: j.joined,
  });

  app.get(
    '/admin/join-requests',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Join requests and sharing per member',
        response: { 200: JoinRequestOverview },
      },
    },
    async () => {
      const pending = await selectRequests(sql`where j.status = 'pending' order by j.created_at`);
      const handled = await selectRequests(
        sql`where j.status <> 'pending' order by j.handled_at desc nulls last limit 100`,
      );
      const sharers = await sql<
        { id: string; name: string; shares: number; opens: number; requests: number; joined: number }[]
      >`
        select u.id, u.name, s.shares, s.opens,
               (select count(*)::int from join_requests j where j.referred_by = u.id) as requests,
               (select count(*)::int from join_requests j
                where j.referred_by = u.id and j.status = 'accepted'
                  and exists (select 1 from users n where n.email = j.email and n.profile_completed_at is not null)
               ) as joined
        from (
          select shared_by, count(*)::int as shares, sum(opens)::int as opens from place_shares group by shared_by
        ) s
        join users u on u.id = s.shared_by
        order by s.opens desc, s.shares desc, lower(u.name)
      `;
      return {
        items: [...pending, ...handled].map(toRequest),
        sharers: sharers.map((s) => ({
          member: { id: s.id, display_name: s.name },
          shares: s.shares,
          opens: s.opens,
          requests: s.requests,
          joined: s.joined,
        })),
      };
    },
  );

  async function handle(id: string, adminId: string, status: 'accepted' | 'dismissed') {
    return sql.begin(async (tx) => {
      const [j] = await tx<
        { email: string; name: string; status: string; referrer: string | null; place: string | null }[]
      >`
        select j.email, j.name, j.status, r.name as referrer, p.name as place
        from join_requests j left join users r on r.id = j.referred_by left join places p on p.id = j.place_id
        where j.id = ${id} for update of j
      `;
      if (!j) throw notFound('Join request');
      if (j.status !== 'pending') throw new HttpError(409, 'already_handled', 'This request was already handled');
      if (status === 'accepted') {
        const note = [`Prośba: ${j.name}`, j.referrer && `poleca ${j.referrer}`, j.place].filter(Boolean).join(' · ');
        await tx`
          insert into allowed_emails (email, role, note, added_by)
          values (${j.email}, 'member', ${note.slice(0, 200)}, ${adminId})
          on conflict (email) do nothing
        `;
      }
      await tx`
        update join_requests set status = ${status}, handled_by = ${adminId}, handled_at = now() where id = ${id}
      `;
    });
  }

  const handledSchema = (summary: string, description: string) => ({
    preHandler: ctx.admin,
    schema: { tags: ['Admin'], summary, description, params: idParams },
  });

  app.post(
    '/admin/join-requests/:id/accept',
    handledSchema(
      'Accept a join request',
      'Puts the e-mail on the list (as a member, added by me) — they can sign in right away. 409 `already_handled`.',
    ),
    async (req, reply) => {
      await handle(req.params.id, req.user.id, 'accepted');
      return reply.status(204).send();
    },
  );

  app.post(
    '/admin/join-requests/:id/dismiss',
    handledSchema('Dismiss a join request', '409 `already_handled`.'),
    async (req, reply) => {
      await handle(req.params.id, req.user.id, 'dismissed');
      return reply.status(204).send();
    },
  );
}
