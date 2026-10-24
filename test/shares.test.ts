import { describe, expect, it } from 'vitest';
import { ADMIN, createPlace, login, pawilon, pushes, setup, type Who } from './helpers.js';

const h = setup();

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, who?: Who, payload?: object) =>
  h.app.inject({ method, url, headers: who?.headers, payload });

const register = (who: Who, name: string) =>
  call('PUT', '/me/devices', who, {
    token: name.padEnd(64, '0'),
    platform: 'ios',
    environment: 'sandbox',
    app_id: 'pl.dobremleko.app',
  });

async function shared() {
  const ola = await login(h.app, 'ola@gmail.com');
  const id = await createPlace(h.app, ola, pawilon, { vibe: 5, offer: 4 });
  const res = await call('POST', `/places/${id}/shares`, ola);
  expect(res.statusCode).toBe(200);
  return { ola, id, token: res.json().token as string, url: res.json().url as string };
}

describe('sharing a place', () => {
  it('gives each member one link per place', async () => {
    const { ola, id, token, url } = await shared();
    expect(url).toBe(`https://dobre-mleko.app/s/${token}`);
    expect((await call('POST', `/places/${id}/shares`, ola)).json().token).toBe(token);
    const kuba = await login(h.app, 'kuba@gmail.com');
    expect((await call('POST', `/places/${id}/shares`, kuba)).json().token).not.toBe(token);
    expect((await call('POST', `/places/${id}/shares`)).statusCode).toBe(401);
  });

  it('shows anyone with the link a preview of that place only', async () => {
    const { id, token } = await shared();
    const res = await call('GET', `/shares/${token}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.place).toMatchObject({ id, name: 'Pawilon Nocny', category_id: 'club', category_label: 'Klub' });
    expect(body.place.rating_avg).toBe(4.5);
    expect(body.place.cover_url).toBe(`https://dobre-mleko.app/api/shares/${token}/cover`);
    expect(body.shared_by).toEqual({ display_name: expect.any(String), badge: null, rating: 4.5 });
    expect(JSON.stringify(body)).not.toContain('@'); // no e-mails

    const cover = await call('GET', `/shares/${token}/cover`);
    expect(cover.statusCode).toBe(200);
    expect(cover.headers['content-type']).toBe('image/jpeg');
    expect(cover.headers['cache-control']).toContain('public');

    expect((await call('GET', '/shares/nonexistent00')).statusCode).toBe(404);
    await h.sql`update places set status = 'closed' where id = ${id}`;
    expect((await call('GET', `/shares/${token}`)).statusCode).toBe(404);
  });

  it('gives link-preview bots an Open Graph page, escaped', async () => {
    const { id, token } = await shared();
    await h.sql`update places set name = ${'Bar "<Pod>" & Spółka'} where id = ${id}`;
    const res = await call('GET', `/shares/${token}/og`);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<meta property="og:title" content="Bar &quot;&lt;Pod&gt;&quot; &amp; Spółka — poleca');
    expect(res.body).toContain(
      `<meta property="og:image" content="https://dobre-mleko.app/api/shares/${token}/cover">`,
    );
    expect(res.body).toContain(`<meta property="og:url" content="https://dobre-mleko.app/s/${token}">`);
    expect(res.body).toContain('ocena 4,5/5');
  });

  it('counts opened links', async () => {
    const { token } = await shared();
    await call('POST', `/shares/${token}/open`);
    await call('POST', `/shares/${token}/open`);
    const [row] = await h.sql`select opens from place_shares where token = ${token}`;
    expect(row!.opens).toBe(2);
  });
});

describe('asking to join', () => {
  it('lets an admin put the e-mail on the list, and tells the member who shared when they join', async () => {
    const { ola, token } = await shared();
    const admin = await login(h.app, ADMIN);
    await register(admin, 'admin');
    await register(ola, 'ola');
    pushes.sent = [];

    const ask = await call('POST', '/join-requests', undefined, {
      email: ' Nowy@Gmail.com ',
      name: 'Nowy',
      share_token: token,
    });
    expect(ask.json()).toEqual({ status: 'pending' });
    // Asking again updates the same request.
    await call('POST', '/join-requests', undefined, { email: 'nowy@gmail.com', name: 'Nowy Nowak' });
    await h.app.settle();
    expect(pushes.sent.map((p) => p.title)).toEqual(['Prośba o dołączenie: Nowy']);
    expect(pushes.sent[0]!.body).toContain('nowy@gmail.com — poleca');

    expect((await call('GET', '/admin/join-requests', ola)).statusCode).toBe(403);
    const list = (await call('GET', '/admin/join-requests', admin)).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ email: 'nowy@gmail.com', name: 'Nowy Nowak', status: 'pending' });
    expect(list.items[0].place.name).toBe('Pawilon Nocny');
    expect(list.sharers[0]).toMatchObject({ shares: 1, requests: 1, joined: 0 });

    const id = list.items[0].id;
    expect((await call('POST', `/admin/join-requests/${id}/accept`, admin)).statusCode).toBe(204);
    expect((await call('POST', `/admin/join-requests/${id}/accept`, admin)).statusCode).toBe(409);
    const [allowed] = await h.sql`select note, added_by from allowed_emails where email = 'nowy@gmail.com'`;
    expect(allowed!.added_by).toBe(admin.id);
    expect(allowed!.note).toContain('Pawilon Nocny');

    pushes.sent = [];
    const nowy = await login(h.app, 'nowy@gmail.com');
    await call('POST', '/me/profile', nowy, { display_name: 'Nowy' });
    await h.app.settle();
    const byToken = Object.fromEntries(pushes.sent.map((p) => [p.token.replace(/0+$/, ''), p.body]));
    expect(byToken).toEqual({ ola: 'Dzięki Twojemu poleceniu 🥛', admin: 'nowy@gmail.com — z Twojej listy' });

    const after = (await call('GET', '/admin/join-requests', admin)).json();
    expect(after.items[0]).toMatchObject({ status: 'accepted', joined: true });
    expect(after.sharers[0]).toMatchObject({ requests: 1, joined: 1 });
  });

  it('says when the e-mail is already on the list, and can be dismissed', async () => {
    expect((await call('POST', '/join-requests', undefined, { email: 'ola@gmail.com', name: 'Ola' })).json()).toEqual({
      status: 'allowed',
    });
    await call('POST', '/join-requests', undefined, { email: 'spam@example.com', name: 'Spam' });
    const admin = await login(h.app, ADMIN);
    const [{ id }] = (await call('GET', '/admin/join-requests', admin)).json().items;
    expect((await call('POST', `/admin/join-requests/${id}/dismiss`, admin)).statusCode).toBe(204);
    const [allowed] = await h.sql`select 1 from allowed_emails where email = 'spam@example.com'`;
    expect(allowed).toBeUndefined();
    expect((await call('POST', '/join-requests', undefined, { email: 'nope', name: 'X' })).statusCode).toBe(422);
  });
});
