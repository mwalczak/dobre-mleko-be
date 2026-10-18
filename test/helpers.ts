import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureAdmins, type AppleIdentity, type GoogleIdentity } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, migrate, type Sql } from '../src/db.js';
import { HttpError } from '../src/errors.js';
import type { PushMessage, PushResult, PushSender, PushTarget } from '../src/push.js';

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mleko:mleko@localhost:5432/mleko_test';

/** One photo directory per test file, removed afterwards. */
export const PHOTO_DIR = mkdtempSync(join(tmpdir(), 'mleko-photos-'));

/** Whitelisted as members before each test; ADMIN is the admin from the environment. */
export const ALLOWED = ['ola@gmail.com', 'kuba@gmail.com', 'tomek@gmail.com'];
export const ADMIN = 'marta@gmail.com';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    ADMIN_EMAILS: ADMIN,
    GOOGLE_CLIENT_IDS: 'test-client',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    PHOTO_DIR,
    PMO_API_URL: 'https://pmo.test',
    PMO_API_KEY: 'pmo_a_test',
    ...overrides,
  });
}

/** Fake Google: the ID token "google:<email>[:unverified]" stands for that account. */
export async function fakeGoogle(idToken: string): Promise<GoogleIdentity> {
  const [prefix, email, flag] = idToken.split(':');
  if (prefix !== 'google' || !email) throw new HttpError(401, 'invalid_google_token', 'bad token');
  return {
    sub: `sub-${email}`,
    email,
    emailVerified: flag !== 'unverified',
    name: email.split('@')[0]!.replace(/^./, (c) => c.toUpperCase()),
    picture: null,
  };
}

/** Fake Apple: "apple:<sub>:<email or empty>[:private|:unverified]". */
export async function fakeApple(idToken: string): Promise<AppleIdentity> {
  const [prefix, sub, email, flag] = idToken.split(':');
  if (prefix !== 'apple' || !sub) throw new HttpError(401, 'invalid_apple_token', 'bad token');
  return { sub, email: email || null, emailVerified: flag !== 'unverified', privateEmail: flag === 'private' };
}

export type TestApp = Awaited<ReturnType<typeof buildApp>>;

/** Records push notifications instead of calling APNs; tokens in `gone` are reported as no longer valid. */
export class FakePushSender implements PushSender {
  configured = true;
  sent: { token: string; title: string; body: string; placeId?: string | null }[] = [];
  gone = new Set<string>();
  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    this.sent.push({ token: target.token, ...message });
    return this.gone.has(target.token) ? 'gone' : 'delivered';
  }
  close(): void {}
}

export const pushes = new FakePushSender();

export interface Harness {
  sql: Sql;
  app: TestApp;
  clock: { now: Date };
  build: (overrides?: Record<string, string>) => Promise<TestApp>;
}

/** Redirects for Google Maps short links in tests: short URL → where it leads. No real requests are made. */
export const mapsRedirects: Record<string, string> = {};
const fakeMapsFetch: typeof fetch = async (input) => {
  const target = mapsRedirects[String(input)];
  return new Response(null, target ? { status: 302, headers: { location: target } } : { status: 404 });
};

/**
 * A fake PMO (the issue tracker behind /reports) holding issues in memory. It records requests, serves the DM
 * project's options, hides private issues from listings like the real one, accepts image and video attachments
 * (rejecting `.bad` file names), and answers `status` with an error while set.
 */
export class FakePmo {
  issues: Record<string, unknown>[] = [];
  attachments: { issue: string; filename: string; type: string; size: number }[] = [];
  requests: { method: string; url: string; authorization: string | null; body: Record<string, unknown> | null }[] = [];
  status: number | null = null;
  options = {
    issue_types: [
      { id: 'bug', label: 'Błąd' },
      { id: 'idea', label: 'Pomysł' },
      { id: 'abuse', label: 'Nadużycie' },
    ],
    platforms: [
      { id: 'web', label: 'Web' },
      { id: 'android', label: 'Android' },
      { id: 'ios', label: 'iOS' },
    ],
  };

  reset() {
    this.issues = [];
    this.attachments = [];
    this.requests = [];
    this.status = null;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const form = init?.body instanceof FormData ? init.body : null;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const headers = new Headers(init?.headers);
    this.requests.push({
      method: init?.method ?? 'GET',
      url: url.pathname + url.search,
      authorization: headers.get('authorization'),
      body,
    });
    if (this.status)
      return Response.json({ error: 'x', message: `fake PMO error ${this.status}` }, { status: this.status });
    if (url.pathname === '/v1/projects/DM') return Response.json({ key: 'DM', ...this.options });
    const attachment = url.pathname.match(/^\/v1\/issues\/(DM-\d+)\/attachments$/);
    if (attachment && form) {
      const file = form.get('file') as File;
      if (file.name.endsWith('.bad'))
        return Response.json({ error: 'unsupported_type', message: 'no' }, { status: 415 });
      this.attachments.push({ issue: attachment[1]!, filename: file.name, type: file.type, size: file.size });
      return Response.json({ id: `att-${this.attachments.length}`, kind: file.type.split('/')[0] }, { status: 201 });
    }
    if (url.pathname !== '/v1/projects/DM/issues')
      return Response.json({ error: 'not_found', message: 'project not found' }, { status: 404 });
    if (init?.method === 'POST') {
      const n = this.issues.length + 1;
      const issue = {
        id: `id-${n}`,
        key: `DM-${n}`,
        project: 'DM',
        number: n,
        type: body.type,
        priority: 'P3',
        status: 'reported',
        title: body.title,
        description: body.description,
        platform: body.platform,
        private: body.type === 'abuse',
        reporter: { id: 'u', name: body.reporter.name },
        milestone: null,
        duplicate_of: null,
        source_app: 'dobre-mleko.app',
        created_at: new Date(Date.UTC(2026, 9, 11, 12, n)).toISOString(),
        updated_at: new Date(Date.UTC(2026, 9, 11, 12, n)).toISOString(),
      };
      this.issues.push(issue);
      return Response.json(issue, { status: 201 });
    }
    const status = url.searchParams.get('status');
    const statuses =
      status === 'open'
        ? ['reported', 'accepted', 'in_progress', 'in_review', 'waiting_for_release']
        : status === 'closed'
          ? ['done', 'wont_fix', 'duplicate']
          : null;
    const q = url.searchParams.get('q')?.toLowerCase();
    const items = this.issues
      .filter((i) => !i.private && (!statuses || statuses.includes(i.status as string)))
      .filter((i) => !q || String(i.title).toLowerCase().includes(q))
      .reverse();
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const more = items.length > offset + limit;
    return Response.json({ items: items.slice(offset, offset + limit), next_offset: more ? offset + limit : null });
  };
}

export const pmo = new FakePmo();

/** The categories migration 007 creates, restored before each test. */
let defaultCategories: Record<string, unknown>[] = [];
let defaultIcons: Record<string, unknown>[] = [];

/** Fresh schema per test file, tables truncated before each test (categories reset to the defaults). */
export function setup(): Harness {
  const h = { clock: { now: new Date('2026-10-11T12:00:00Z') } } as Harness;

  beforeAll(async () => {
    h.sql = createDb(DATABASE_URL);
    await h.sql.unsafe('drop schema public cascade; create schema public;');
    await migrate(h.sql);
    defaultIcons = await h.sql`select * from icons`;
    defaultCategories = await h.sql`select * from categories`;
    h.build = (overrides = {}) =>
      buildApp({
        config: testConfig(overrides),
        sql: h.sql,
        verifyGoogle: fakeGoogle,
        verifyApple: fakeApple,
        now: () => h.clock.now,
        settingsCacheMs: 0,
        pushSender: pushes,
        fetchMapsLink: fakeMapsFetch,
        fetchPmo: pmo.fetch,
      });
    h.app = await h.build();
  });

  beforeEach(async () => {
    h.clock.now = new Date('2026-10-11T12:00:00Z');
    await h.sql`truncate users, places, place_photos, ratings, stars, comments, saved_places, allowed_emails, settings, categories, icons, push_log cascade`;
    pushes.sent = [];
    pushes.gone.clear();
    pmo.reset();
    await h.sql`insert into icons ${h.sql(defaultIcons)}`;
    await h.sql`insert into categories ${h.sql(defaultCategories)}`;
    rmSync(PHOTO_DIR, { recursive: true, force: true });
    await ensureAdmins(h.sql, [ADMIN]);
    for (const email of ALLOWED) await h.sql`insert into allowed_emails (email) values (${email})`;
  });

  afterAll(async () => {
    await h.app?.close();
    await h.sql?.end();
    rmSync(PHOTO_DIR, { recursive: true, force: true });
  });

  return h;
}

export type Who = { id: string; headers: { authorization: string } };

export async function login(app: TestApp, email: string): Promise<Who> {
  const res = await app.inject({ method: 'POST', url: '/auth/google', payload: { id_token: `google:${email}` } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { id: body.user.id, headers: { authorization: `Bearer ${body.token}` } };
}

/** A real, decodable JPEG; different seeds give different files. */
export async function makeImage(seed = 0, width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: (seed * 37) % 256, g: (seed * 91) % 256, b: 120 } },
  })
    .jpeg()
    .toBuffer();
}

export function multipart(parts: { name: string; value: string | Buffer; filename?: string; type?: string }[]) {
  const boundary = '----mleko' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"` +
      (p.filename ? `; filename="${p.filename}"\r\nContent-Type: ${p.type ?? 'application/octet-stream'}` : '') +
      '\r\n\r\n';
    chunks.push(Buffer.from(head), Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function upload(
  app: TestApp,
  who: Who,
  file: Buffer,
  opts: { blurhash?: string; url?: string; method?: 'POST' | 'PUT' } = {},
) {
  const parts: Parameters<typeof multipart>[0] = [{ name: 'file', value: file, filename: 'x.jpg', type: 'image/jpeg' }];
  if (opts.blurhash) parts.unshift({ name: 'blurhash', value: opts.blurhash });
  const { payload, contentType } = multipart(parts);
  return app.inject({
    method: opts.method ?? 'POST',
    url: opts.url ?? '/photos',
    headers: { ...who.headers, 'content-type': contentType },
    payload,
  });
}

let imageSeed = 1;
/** Uploads a fresh photo and returns its id. */
export async function photoId(app: TestApp, who: Who): Promise<string> {
  const res = await upload(app, who, await makeImage(imageSeed++));
  if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
  return res.json().id;
}

export const pawilon = {
  name: 'Pawilon Nocny',
  category_id: 'club',
  price_level: 2,
  address: 'ul. Nowy Świat 22',
  location: { lat: 52.2319, lng: 21.0186 },
  description: 'Najlepszy dźwięk w mieście i zero lansu.',
  tags: ['Późno w nocy', 'Muzyka na żywo', 'Ogródek'],
};

export const podPionem = {
  name: 'Bar Pod Pionem',
  category_id: 'bar',
  location: { lat: 52.2297, lng: 21.0122 },
};

export const kreska = {
  name: 'Kawiarnia Ostra Kreska',
  category_id: 'coffee',
  // Kraków, far from the others.
  location: { lat: 50.0614, lng: 19.9366 },
};

/**
 * Adds a place with the author's rating and one fresh photo (both required). `rating` defaults to 4/4.
 * Returns the new place's id.
 */
export async function createPlace(
  app: TestApp,
  who: Who,
  payload: Record<string, unknown>,
  rating: Record<string, unknown> = { vibe: 4, offer: 4 },
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/places',
    headers: who.headers,
    payload: { rating, photo_ids: [await photoId(app, who)], ...payload },
  });
  if (res.statusCode !== 201) throw new Error(`create place failed: ${res.statusCode} ${res.body}`);
  return res.json().id;
}

/** Rates a place with a fresh photo. */
export async function rate(app: TestApp, who: Who, placeId: string, scores: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: `/places/${placeId}/rating`,
    headers: who.headers,
    payload: { photo_ids: [await photoId(app, who)], ...scores },
  });
}
