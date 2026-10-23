import { describe, expect, it } from 'vitest';
import { ADMIN, createPlace, login, pawilon, podPionem, pushes, setup, type Who } from './helpers.js';

const h = setup();

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, who?: Who, payload?: object) =>
  h.app.inject({ method, url, headers: who?.headers, payload });

const tokenOf = (name: string) => `${name}`.padEnd(64, '0');
const register = (who: Who, name: string, app_id = 'pl.dobremleko.app') =>
  call('PUT', '/me/devices', who, { token: tokenOf(name), platform: 'ios', environment: 'sandbox', app_id });

/** Event notifications run after the response: wait until the log has `count` entries. */
async function logged(count: number) {
  for (let i = 0; i < 100; i++) {
    const [{ n }] = await h.sql<[{ n: number }]>`select count(*)::int as n from push_log`;
    if (n >= count) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`push_log never reached ${count}`);
}

const sentTo = () => pushes.sent.map((p) => p.token.replace(/0+$/, '')).sort();

describe('devices and settings', () => {
  it('registers a device, moves it to whoever signs in on it, and unregisters it', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    expect((await register(ola, 'phone')).statusCode).toBe(204);
    expect((await register(kuba, 'phone')).statusCode).toBe(204);
    const [row] = await h.sql`select user_id from devices`;
    expect(row!.user_id).toBe(kuba.id);
    expect((await call('DELETE', `/me/devices/${tokenOf('phone')}`, ola)).statusCode).toBe(204);
    expect(await h.sql`select 1 from devices`).toHaveLength(1); // not Ola's any more
    expect((await call('DELETE', `/me/devices/${tokenOf('phone')}`, kuba)).statusCode).toBe(204);
    expect(await h.sql`select 1 from devices`).toHaveLength(0);
  });

  it('accepts only the configured iOS app ids', async () => {
    const app = await h.build({ APNS_APP_IDS: 'pl.dobremleko.app,pl.dobremleko.app.dev' });
    const ola = await login(app, 'ola@gmail.com');
    const put = (app_id: string) =>
      app.inject({
        method: 'PUT',
        url: '/me/devices',
        headers: ola.headers,
        payload: { token: tokenOf('x'), platform: 'ios', environment: 'sandbox', app_id },
      });
    expect((await put('pl.dobremleko.app.dev')).statusCode).toBe(204);
    expect((await put('com.example.other')).statusCode).toBe(422);
    // The list is for iOS (APNs topics); Android tokens belong to the Firebase project.
    const android = await app.inject({
      method: 'PUT',
      url: '/me/devices',
      headers: ola.headers,
      payload: { token: tokenOf('pixel'), platform: 'android', environment: 'production', app_id: 'app.dobremleko' },
    });
    expect(android.statusCode).toBe(204);
    await app.close();
  });

  it('keeps notification preferences on the profile', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const defaults = { new_places: 'favorites', comments: true, gold_stars: true, joins: true };
    expect((await call('GET', '/me', ola)).json().notifications).toEqual(defaults);
    const res = await call('PATCH', '/me', ola, { notifications: { new_places: 'all', gold_stars: false } });
    expect(res.json().notifications).toEqual({ ...defaults, new_places: 'all', gold_stars: false });
    expect((await call('PATCH', '/me', ola, { notifications: { new_places: 'some' } })).statusCode).toBe(422);
  });
});

describe('event notifications', () => {
  it('tells people about a new place in their favourite categories, or all of them', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    await call('PATCH', '/me', kuba, { favorite_categories: ['club'] });
    await call('PATCH', '/me', tomek, { favorite_categories: ['bar'] });
    await register(ola, 'ola');
    await register(kuba, 'kuba');
    await register(tomek, 'tomek');

    const id = await createPlace(h.app, ola, pawilon); // club
    await logged(1);
    expect(sentTo()).toEqual(['kuba']); // not the author, not Tomek (bar)
    expect(pushes.sent[0]).toMatchObject({ title: 'Nowe miejsce: Pawilon Nocny', placeId: id });
    expect(pushes.sent[0]!.body).toContain('Klub');

    await call('PATCH', '/me', tomek, { notifications: { new_places: 'all' } });
    await call('PATCH', '/me', kuba, { notifications: { new_places: 'none' } });
    pushes.sent = [];
    await createPlace(h.app, ola, { ...pawilon, name: 'Klub Drugi' });
    await logged(2);
    expect(sentTo()).toEqual(['tomek']);
  });

  it('tells the author, other commenters and savers about a comment', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const admin = await login(h.app, ADMIN);
    for (const [who, name] of [
      [ola, 'ola'],
      [kuba, 'kuba'],
      [tomek, 'tomek'],
      [admin, 'admin'],
    ] as const) {
      await register(who, name);
    }
    const id = await createPlace(h.app, ola, podPionem);
    await logged(1);
    await call('PUT', `/places/${id}/saved`, tomek);
    await call('POST', `/places/${id}/comments`, admin, { body: 'Byłam, polecam.' });
    await logged(2);
    pushes.sent = [];

    await call('POST', `/places/${id}/comments`, kuba, { body: 'Zgadzam się w stu procentach!' });
    await logged(3);
    expect(sentTo()).toEqual(['admin', 'ola', 'tomek']); // author, earlier commenter, saver — not Kuba
    expect(pushes.sent[0]).toMatchObject({ body: 'Zgadzam się w stu procentach!', placeId: id });

    await call('PATCH', '/me', ola, { notifications: { comments: false } });
    pushes.sent = [];
    await call('POST', `/places/${id}/comments`, kuba, { body: 'I jeszcze jedno.' });
    await logged(4);
    expect(sentTo()).toEqual(['admin', 'tomek']);
  });

  it("tells the place's author about a gold star, not about their own", async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    await register(ola, 'ola');
    await register(kuba, 'kuba');
    const id = await createPlace(h.app, ola, podPionem);
    await logged(1);
    pushes.sent = [];

    expect((await call('POST', `/places/${id}/gold-star`, kuba)).statusCode).toBe(200);
    await logged(2);
    expect(sentTo()).toEqual(['ola']);
    expect(pushes.sent[0]).toMatchObject({ title: 'Złota Gwiazdka dla: Bar Pod Pionem', placeId: id });
    const [log] = await h.sql`select kind from push_log order by created_at desc limit 1`;
    expect(log!.kind).toBe('gold_star');

    pushes.sent = [];
    expect((await call('POST', `/places/${id}/gold-star`, ola)).statusCode).toBe(200);
    await call('PATCH', '/me', ola, { notifications: { gold_stars: false } });
    await call('DELETE', `/places/${id}/gold-star`, kuba);
    await call('POST', `/places/${id}/gold-star`, kuba);
    await h.app.settle();
    expect(pushes.sent).toEqual([]);
  });

  it('tells whoever put the e-mail on the list that the person joined, once', async () => {
    const admin = await login(h.app, ADMIN);
    await register(admin, 'admin');
    await call('POST', '/admin/allowed', admin, { email: 'nowa@gmail.com' });
    const nowa = await login(h.app, 'nowa@gmail.com');
    const profile = { display_name: 'Nowa', favorite_categories: [] };
    expect((await call('POST', '/me/profile', nowa, profile)).statusCode).toBe(200);
    await logged(1);
    expect(sentTo()).toEqual(['admin']);
    expect(pushes.sent[0]).toMatchObject({ title: 'Nowa dołącza do Dobrego Mleka' });
    expect(pushes.sent[0]!.body).toContain('nowa@gmail.com');

    pushes.sent = [];
    await call('POST', '/me/profile', nowa, { ...profile, display_name: 'Nowa Druga' });
    // On the list without anyone adding them (here: by the test setup) — nobody to tell.
    const ola = await login(h.app, 'ola@gmail.com');
    await call('POST', '/me/profile', ola, { display_name: 'Ola' });
    await h.app.settle();
    expect(pushes.sent).toEqual([]);
  });
});

describe('admin push panel', () => {
  it('is for admins only', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    expect((await call('GET', '/admin/push', ola)).statusCode).toBe(403);
    const send = { audience: { kind: 'all' }, title: 'Hej', body: 'Test' };
    expect((await call('POST', '/admin/push', ola, send)).statusCode).toBe(403);
  });

  it('shows who gets notifications on which devices', async () => {
    const admin = await login(h.app, ADMIN);
    const ola = await login(h.app, 'ola@gmail.com');
    await register(ola, 'ola');
    const res = (await call('GET', '/admin/push', admin)).json();
    expect(res.configured).toBe(true);
    const olaRow = res.members.find((m: { email: string }) => m.email === 'ola@gmail.com');
    expect(olaRow).toMatchObject({
      notifications: { new_places: 'favorites', comments: true, gold_stars: true, joins: true },
      devices: [{ platform: 'ios', environment: 'sandbox', app_id: 'pl.dobremleko.app' }],
    });
    expect(res.members.find((m: { email: string }) => m.email === ADMIN).devices).toEqual([]);
  });

  it('sends to everyone, to chosen people or by favourite category, forgets dead tokens and logs it', async () => {
    const admin = await login(h.app, ADMIN);
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    await call('PATCH', '/me', kuba, { favorite_categories: ['coffee'] });
    await register(ola, 'ola');
    await register(ola, 'olaipad');
    await register(kuba, 'kuba');
    pushes.gone.add(tokenOf('olaipad'));

    const all = await call('POST', '/admin/push', admin, {
      audience: { kind: 'all' },
      title: 'Hej',
      body: 'Do wszystkich',
    });
    expect(all.json()).toEqual({ recipients: 3, devices: 3, delivered: 2, failed: 1 });
    expect(await h.sql`select token from devices where token = ${tokenOf('olaipad')}`).toHaveLength(0);

    pushes.sent = [];
    const chosen = await call('POST', '/admin/push', admin, {
      audience: { kind: 'users', user_ids: [ola.id] },
      title: 'Ola',
      body: 'Tylko do Oli',
    });
    expect(chosen.json()).toMatchObject({ recipients: 1, devices: 1, delivered: 1 });
    expect(sentTo()).toEqual(['ola']);

    pushes.sent = [];
    const place = await createPlace(h.app, ola, pawilon);
    await logged(3);
    pushes.sent = [];
    const coffee = await call('POST', '/admin/push', admin, {
      audience: { kind: 'categories', categories: ['coffee'] },
      title: 'Kawa',
      body: 'Dla kawoszy',
      place_id: place,
    });
    expect(coffee.json()).toMatchObject({ recipients: 1, delivered: 1 });
    expect(pushes.sent).toEqual([{ token: tokenOf('kuba'), title: 'Kawa', body: 'Dla kawoszy', placeId: place }]);

    const bad = await call('POST', '/admin/push', admin, {
      audience: { kind: 'categories', categories: ['nope'] },
      title: 'x',
      body: 'y',
    });
    expect(bad.statusCode).toBe(422);

    const log = (await call('GET', '/admin/push/log', admin)).json().items;
    expect(log.map((l: { kind: string }) => l.kind)).toEqual(['admin', 'new_place', 'admin', 'admin']);
    expect(log[0]).toMatchObject({ title: 'Kawa', place_id: place, sent_by: { display_name: expect.any(String) } });
    expect(log[0].audience).toEqual({ kind: 'categories', categories: ['coffee'] });
  });
});
