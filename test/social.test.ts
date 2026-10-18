import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupUnattached, PhotoStore } from '../src/photo-store.js';
import {
  ADMIN,
  createPlace,
  kreska,
  login,
  makeImage,
  pawilon,
  PHOTO_DIR,
  photoId,
  podPionem,
  rate,
  setup,
  upload,
  type Who,
} from './helpers.js';

const h = setup();

describe('comments', () => {
  it('lists comments oldest first with the author’s rating; detail includes them', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const id = await createPlace(h.app, ola, pawilon, { vibe: 4, offer: 4 });
    await rate(h.app, tomek, id, { vibe: 5, offer: 5, service: 5, value: 4 });

    const post = (who: Who, body: string) =>
      h.app.inject({ method: 'POST', url: `/places/${id}/comments`, headers: who.headers, payload: { body } });
    const first = await post(ola, '  Byłam w czwartek — kwartet był świetny.  ');
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      body: 'Byłam w czwartek — kwartet był świetny.',
      author: { display_name: 'Ola' },
      author_rating: 4,
      is_mine: true,
      updated_at: null,
    });
    h.clock.now = new Date('2026-10-12T12:00:00Z');
    await post(tomek, 'Daję gwiazdkę.');

    const list = (await h.app.inject({ method: 'GET', url: `/places/${id}/comments`, headers: ola.headers })).json();
    expect(list.total).toBe(2);
    expect(
      list.items.map((c: { author: { display_name: string }; author_rating: number; is_mine: boolean }) => [
        c.author.display_name,
        c.author_rating,
        c.is_mine,
      ]),
    ).toEqual([
      ['Ola', 4, true],
      ['Tomek', 4.75, false],
    ]);
    const place = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: ola.headers })).json();
    expect(place.comment_count).toBe(2);
    expect(place.comments.map((c: { body: string }) => c.body)).toEqual([
      'Byłam w czwartek — kwartet był świetny.',
      'Daję gwiazdkę.',
    ]);

    expect((await post(ola, '   ')).statusCode).toBe(422);
    expect((await post(ola, 'x'.repeat(1001))).statusCode).toBe(422);
  });

  it('the author edits; the author or an admin deletes', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const admin = await login(h.app, ADMIN);
    const id = await createPlace(h.app, ola, pawilon);
    const c = (
      await h.app.inject({
        method: 'POST',
        url: `/places/${id}/comments`,
        headers: ola.headers,
        payload: { body: 'Hej' },
      })
    ).json();

    const edit = (who: Who) =>
      h.app.inject({ method: 'PATCH', url: `/comments/${c.id}`, headers: who.headers, payload: { body: 'Hej!' } });
    expect((await edit(tomek)).json().error).toBe('not_authorized');
    expect((await edit(admin)).statusCode).toBe(403);
    const edited = (await edit(ola)).json();
    expect(edited).toMatchObject({ body: 'Hej!', updated_at: expect.any(String) });

    expect(
      (await h.app.inject({ method: 'DELETE', url: `/comments/${c.id}`, headers: tomek.headers })).statusCode,
    ).toBe(403);
    expect(
      (await h.app.inject({ method: 'DELETE', url: `/comments/${c.id}`, headers: admin.headers })).statusCode,
    ).toBe(204);
  });
});

describe('photos', () => {
  const fileOf = (url: string) => {
    const hash = url.split('/')[2]!.split('?')[0]!;
    return join(PHOTO_DIR, hash.slice(0, 2), hash);
  };

  it('uploads keep dimensions and blurhash, and are served through signed URLs only', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const image = await makeImage(3, 1200, 800);
    const res = await upload(h.app, ola, image, { blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' });
    expect(res.statusCode).toBe(201);
    const photo = res.json();
    expect(photo).toMatchObject({ width: 1200, height: 800, blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' });
    expect(photo.url).toMatch(/^\/files\/[0-9a-f]{64}\?exp=\d+&sig=/);
    expect(existsSync(fileOf(photo.url))).toBe(true);

    const full = await h.app.inject({ method: 'GET', url: photo.url });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('image/jpeg');
    expect(full.headers['cache-control']).toMatch(/^private, max-age=\d+/);
    expect(full.rawPayload.equals(image)).toBe(true);

    const thumb = await h.app.inject({ method: 'GET', url: photo.thumb_url });
    expect(thumb.statusCode).toBe(200);
    const { default: sharp } = await import('sharp');
    expect(await sharp(thumb.rawPayload).metadata()).toMatchObject({ width: 400, height: 267, format: 'jpeg' });

    // Unsigned, tampered or expired links are refused.
    const [path] = photo.url.split('?');
    expect((await h.app.inject({ method: 'GET', url: path })).statusCode).toBe(422);
    expect((await h.app.inject({ method: 'GET', url: photo.url.replace(/sig=./, 'sig=x') })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: photo.thumb_url.replace('/thumb', '') })).statusCode).toBe(403);
    h.clock.now = new Date(h.clock.now.getTime() + 25 * 3600 * 1000);
    expect((await h.app.inject({ method: 'GET', url: photo.url })).json().error).toBe('not_authorized');
  });

  it('rejects files that are not images, and files over the size setting', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect((await upload(h.app, ola, svg)).statusCode).toBe(415);
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100)]);
    expect((await upload(h.app, ola, broken)).statusCode).toBe(422);
    expect((await upload(h.app, ola, await makeImage(1), { blurhash: 'no spaces allowed' })).statusCode).toBe(422);

    const admin = await login(h.app, ADMIN);
    await h.app.inject({
      method: 'PUT',
      url: '/admin/settings/maxPhotoBytes',
      headers: admin.headers,
      payload: { value: 100 * 1024 },
    });
    const big = await upload(
      h.app,
      ola,
      await makeImage(2, 1500, 1500).then(async () => {
        const { default: sharp } = await import('sharp');
        // Noise does not compress: well over 100 KB.
        const raw = Buffer.alloc(600 * 600 * 3).map(() => Math.floor(Math.random() * 256));
        return sharp(raw, { raw: { width: 600, height: 600, channels: 3 } })
          .jpeg({ quality: 95 })
          .toBuffer();
      }),
    );
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('file_too_large');
  });

  it('the last photo of a rating cannot be deleted; others can, by the uploader or an admin', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const admin = await login(h.app, ADMIN);
    const id = await createPlace(h.app, ola, pawilon);
    const [first] = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: ola.headers })).json().photos;
    const del = (who: Who, photo: string) =>
      h.app.inject({ method: 'DELETE', url: `/photos/${photo}`, headers: who.headers });

    const last = await del(ola, first.id);
    expect(last.statusCode).toBe(409);
    expect(last.json().error).toBe('rating_needs_photo');

    const second = await photoId(h.app, ola);
    await h.app.inject({
      method: 'PUT',
      url: `/places/${id}/rating`,
      headers: ola.headers,
      payload: { vibe: 4, offer: 4, photo_ids: [second] },
    });
    expect((await del(kuba, first.id)).statusCode).toBe(403);
    expect((await del(admin, first.id)).statusCode).toBe(204);
    expect(existsSync(fileOf(first.url))).toBe(false);
  });

  it('identical uploads share one file, removed with the last photo that uses it', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const image = await makeImage(42);
    const a = (await upload(h.app, ola, image)).json();
    const b = (await upload(h.app, ola, image)).json();
    expect(a.id).not.toBe(b.id);
    expect(fileOf(a.url)).toBe(fileOf(b.url));

    const place = await h.app.inject({
      method: 'POST',
      url: '/places',
      headers: ola.headers,
      payload: { ...podPionem, rating: { vibe: 3, offer: 3 }, photo_ids: [a.id] },
    });
    expect(place.statusCode).toBe(201);
    // b was never attached: the cleanup removes it but keeps the shared file for a.
    expect(await cleanupUnattached(h.sql, new PhotoStore(PHOTO_DIR), new Date(Date.now() + 1000))).toBe(1);
    expect(existsSync(fileOf(a.url))).toBe(true);

    await h.app.inject({ method: 'DELETE', url: `/places/${place.json().id}`, headers: ola.headers });
    expect(existsSync(fileOf(a.url))).toBe(false);
  });

  it('a photo can only be attached by its uploader, to one place', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const a = await createPlace(h.app, ola, pawilon);
    const b = await createPlace(h.app, kuba, podPionem);
    const used = (await h.app.inject({ method: 'GET', url: `/places/${a}`, headers: ola.headers })).json().photos[0].id;
    const res = await h.app.inject({
      method: 'PUT',
      url: `/places/${b}/rating`,
      headers: ola.headers,
      payload: { vibe: 4, offer: 4, photo_ids: [used] },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('stats', () => {
  it('summarises the network', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    h.clock.now = new Date('2026-09-20T12:00:00Z'); // three weeks earlier
    const a = await createPlace(h.app, kuba, pawilon, { vibe: 5, offer: 4 });
    h.clock.now = new Date('2026-10-11T12:00:00Z');
    const b = await createPlace(h.app, kuba, podPionem, { vibe: 3, offer: 4 });
    await createPlace(h.app, ola, kreska, { vibe: 4, offer: 4 });
    // created_at comes from the database clock, not the test clock: pin it.
    await h.sql`update ratings set created_at = '2026-10-10T12:00:00Z'`;
    await h.sql`update ratings set created_at = '2026-09-20T12:00:00Z' where place_id = ${a}`;
    for (const who of [ola, kuba])
      await h.app.inject({ method: 'POST', url: `/places/${a}/gold-star`, headers: who.headers });
    await h.app.inject({ method: 'POST', url: `/places/${b}/gold-star`, headers: kuba.headers });

    const net = (await h.app.inject({ method: 'GET', url: '/stats/network', headers: ola.headers })).json();
    expect(net).toMatchObject({
      members: 2,
      places: 3,
      ratings: 3,
      average_rating: 4,
      month: '2026-10-01',
      gold_stars_this_month: 3,
      star_of_the_month: { place: { id: a }, stars: 2 },
    });
    expect(net.top).toHaveLength(3);
    expect(net.categories).toEqual([
      { category_id: 'bar', count: 1 },
      { category_id: 'club', count: 1 },
      { category_id: 'coffee', count: 1 },
    ]);
    // 2026-10-11 is a Sunday: the current week started 2026-10-05; 2026-09-20 is three weeks back.
    expect(net.weekly_activity).toHaveLength(12);
    expect(net.weekly_activity.slice(-4)).toEqual([1, 0, 0, 2]);
  });

  it('summarises me, with taste matches', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const ids = [];
    for (const [i, v] of [5, 4, 2].entries()) {
      ids.push(
        await createPlace(
          h.app,
          ola,
          { ...pawilon, name: `Miejsce ${i}`, category_id: i ? 'bar' : 'club' },
          { vibe: v, offer: v },
        ),
      );
    }
    // Kuba agrees with Ola, Tomek is the opposite.
    for (const [i, v] of [5, 4, 2].entries()) await rate(h.app, kuba, ids[i]!, { vibe: v, offer: v });
    for (const [i, v] of [1, 3, 5].entries()) await rate(h.app, tomek, ids[i]!, { vibe: v, offer: v });
    await h.app.inject({ method: 'POST', url: `/places/${ids[0]}/gold-star`, headers: kuba.headers });

    const me = (await h.app.inject({ method: 'GET', url: '/stats/me', headers: ola.headers })).json();
    expect(me).toMatchObject({
      places_added: 3,
      ratings_given: 3,
      average_given: 3.67,
      distribution: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 },
      categories: [
        { category_id: 'bar', count: 2 },
        { category_id: 'club', count: 1 },
      ],
      gold_stars: { given_total: 0, given_this_month: 0, left: 3 },
    });
    expect(
      me.taste_matches.map((m: { profile: { display_name: string }; match: number; shared: number }) => [
        m.profile.display_name,
        m.match,
        m.shared,
      ]),
    ).toEqual([
      ['Kuba', 0.688, 3], // r = 1, shrunk with 3 shared: 0.5 + 0.5 · 3 / 8
      ['Tomek', 0.316, 3], // r = -0.982
    ]);
    expect(me.my_places_with_stars).toMatchObject([{ place: { id: ids[0] }, stars: 1 }]);
  });

  it('lists members with counts, last activity and taste match', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const ids = [];
    for (const [i, v] of [5, 4, 2, 3].entries()) {
      ids.push(await createPlace(h.app, ola, { ...pawilon, name: `Miejsce ${i}` }, { vibe: v, offer: v }));
    }
    for (const [i, v] of [5, 4, 2, 3].entries()) await rate(h.app, kuba, ids[i]!, { vibe: v, offer: v });
    // Two shared places only: no match yet.
    for (const [i, v] of [5, 4].entries()) await rate(h.app, tomek, ids[i]!, { vibe: v, offer: v });
    await h.app.inject({
      method: 'POST',
      url: '/me/wishlist',
      headers: tomek.headers,
      payload: { name: 'Jachta', lat: 52.2, lng: 21 },
    });

    const res = await h.app.inject({ method: 'GET', url: '/members', headers: ola.headers });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.total).toBe(list.items.length);
    const row = (name: string) =>
      list.items.find((m: { profile: { display_name: string } }) => m.profile.display_name === name);
    expect(list.items.slice(0, 3).map((m: { profile: { display_name: string } }) => m.profile.display_name)).toEqual([
      'Tomek',
      'Kuba',
      'Ola',
    ]);
    expect(row('Ola')).toMatchObject({ places_added: 4, ratings: 4, wishlist_to_visit: 0, match: null, shared: null });
    expect(row('Kuba')).toMatchObject({ places_added: 0, ratings: 4, match: 0.722, shared: 4 }); // 0.5 + 0.5 · 4/9
    expect(row('Tomek')).toMatchObject({ ratings: 2, wishlist_to_visit: 1, match: null, shared: 2 });

    await h.app.inject({ method: 'DELETE', url: '/me', headers: tomek.headers });
    const after = (await h.app.inject({ method: 'GET', url: '/members', headers: ola.headers })).json();
    expect(after.items.map((m: { profile: { id: string } }) => m.profile.id)).not.toContain(tomek.id);
  });

  it('exposes categories, criteria and limits', async () => {
    const meta = (await h.app.inject({ method: 'GET', url: '/meta' })).json();
    expect(meta).toMatchObject({
      gold_stars_per_month: 3,
      max_photos_per_rating: 6,
      time_zone: 'Europe/Warsaw',
      google_web_client_id: null,
      dev_login: false,
      criteria: [{ key: 'vibe', required: true }, {}, {}, {}],
    });
    expect(meta.categories).toHaveLength(15);
  });
});
