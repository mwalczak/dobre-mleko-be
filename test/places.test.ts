import { describe, expect, it } from 'vitest';
import { ADMIN, createPlace, kreska, login, pawilon, photoId, podPionem, setup } from './helpers.js';

const h = setup();
const center = 'lat=52.2297&lng=21.0122';

type Item = { id: string; name: string; distance_m: number | null };
type List = { items: Item[]; next_cursor: string | null; total: number };

describe('adding places', () => {
  it('adds a place with the author’s rating and photo in one step', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const photo = await photoId(h.app, kuba);
    const res = await h.app.inject({
      method: 'POST',
      url: '/places',
      headers: kuba.headers,
      payload: {
        ...pawilon,
        opening_hours: [{ day: 0, open: '00:00', close: '23:59' }],
        rating: { vibe: 5, offer: 4, service: 4 },
        photo_ids: [photo],
        gold_star: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const place = res.json();
    expect(place).toMatchObject({
      name: 'Pawilon Nocny',
      category_id: 'club',
      status: 'active',
      price_level: 2,
      description: 'Najlepszy dźwięk w mieście i zero lansu.',
      tags: ['Późno w nocy', 'Muzyka na żywo', 'Ogródek'],
      author: { id: kuba.id, display_name: 'Kuba', role: 'member' },
      rating_avg: 4.33,
      rating_count: 1,
      my_rating: 4.33,
      my_scores: { vibe: 5, offer: 4, service: 4, value: null },
      gold_star_count: 1,
      gold_stars_left: 2,
      my_gold_star: { awarded_at: expect.any(String) },
      can_revoke_gold_star: true,
      comment_count: 0,
      open_now: true, // the test clock is a Sunday
      is_mine: true,
      is_saved: false,
    });
    expect(place.author).not.toHaveProperty('email');
    expect(place.photos).toHaveLength(1);
    expect(place.photos[0]).toMatchObject({ id: photo, uploaded_by: kuba.id });
    expect(place.cover_photo.id).toBe(photo);
  });

  it('keeps the visit date given with the author’s rating, but not one in the future', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const add = async (visited_on: string) =>
      h.app.inject({
        method: 'POST',
        url: '/places',
        headers: kuba.headers,
        payload: { ...pawilon, rating: { vibe: 5, offer: 4, visited_on }, photo_ids: [await photoId(h.app, kuba)] },
      });
    expect((await add('2026-10-12')).statusCode).toBe(422); // clock: 2026-10-11
    const res = await add('2026-10-04');
    expect(res.statusCode).toBe(201);
    expect(res.json().my_visited_on).toBe('2026-10-04');
  });

  it('accepts every category, hotels included', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    await createPlace(h.app, kuba, {
      name: 'Hotel Pod Wieżą',
      category_id: 'hotel',
      location: { lat: 50.0955, lng: 18.5419 },
    });
    const res = await h.app.inject({ method: 'GET', url: '/places?categories=hotel', headers: kuba.headers });
    expect(res.json().items.map((p: Item & { category_id: string }) => [p.name, p.category_id])).toEqual([
      ['Hotel Pod Wieżą', 'hotel'],
    ]);
    const meta = await h.app.inject({ method: 'GET', url: '/meta' });
    expect(meta.json().categories).toContain('hotel');
  });

  it('requires a rating and at least one of my own unattached photos', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const post = (payload: object) => h.app.inject({ method: 'POST', url: '/places', headers: kuba.headers, payload });
    const rating = { vibe: 4, offer: 4 };

    expect((await post({ ...pawilon, photo_ids: [await photoId(h.app, kuba)] })).statusCode).toBe(422); // no rating
    expect((await post({ ...pawilon, rating, photo_ids: [] })).statusCode).toBe(422);
    const olas = await post({ ...pawilon, rating, photo_ids: [await photoId(h.app, ola)] });
    expect(olas.statusCode).toBe(422);
    expect(olas.json().error).toBe('invalid_input');
    // Nothing was left behind by the failed attempts.
    const [{ n }] = await h.sql<[{ n: number }]>`select count(*)::int as n from places`;
    expect(n).toBe(0);
  });

  it('validates input with 422 invalid_input', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const bad = (payload: object) =>
      h.app.inject({
        method: 'POST',
        url: '/places',
        headers: kuba.headers,
        payload: { rating: { vibe: 4, offer: 4 }, photo_ids: [], ...payload },
      });
    expect((await bad({ ...pawilon, category_id: 'disco' })).json().error).toBe('invalid_input');
    expect((await bad({ ...pawilon, description: 'x'.repeat(501) })).statusCode).toBe(422);
  });

  it('does not add the same Google place twice', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = await createPlace(h.app, kuba, { ...pawilon, google_place_id: 'ChIJ123' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/places',
      headers: kuba.headers,
      payload: {
        ...pawilon,
        google_place_id: 'ChIJ123',
        rating: { vibe: 4, offer: 4 },
        photo_ids: [await photoId(h.app, kuba)],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'place_exists', place_id: id });
  });
});

describe('search', () => {
  async function seed() {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const a = await createPlace(h.app, kuba, pawilon, { vibe: 5, offer: 5 });
    const b = await createPlace(h.app, kuba, { ...podPionem, price_level: 1, description: 'Żółw na ścianie' });
    const c = await createPlace(h.app, ola, kreska, { vibe: 2, offer: 2 });
    return { kuba, ola, a, b, c };
  }
  const list = async (who: { headers: object }, qs: string): Promise<List> => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/places?${qs}`,
      headers: who.headers as Record<string, string>,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const names = (l: List) => l.items.map((p) => p.name);

  it('searches name, description, address and tags, ignoring case and Polish accents', async () => {
    const { kuba } = await seed();
    expect(names(await list(kuba, 'q=PIONEM'))).toEqual(['Bar Pod Pionem']);
    expect(names(await list(kuba, 'q=zolw'))).toEqual(['Bar Pod Pionem']); // description, no accents
    expect(names(await list(kuba, 'q=swiat'))).toEqual(['Pawilon Nocny']); // address
    expect(names(await list(kuba, 'q=muzyka'))).toEqual(['Pawilon Nocny']); // tag
    expect((await list(kuba, 'q=100%25')).total).toBe(0); // wildcards are literal
  });

  it('filters by category, price, tags, rating, author, gold stars and my ratings', async () => {
    const { kuba, ola, a, b } = await seed();
    expect((await list(kuba, 'categories=bar,club')).total).toBe(2);
    expect(names(await list(kuba, 'prices=1'))).toEqual(['Bar Pod Pionem']);
    expect(names(await list(kuba, 'tags=Ogródek,Jazz'))).toEqual(['Pawilon Nocny']);
    expect(names(await list(kuba, 'min_rating=4.5'))).toEqual(['Pawilon Nocny']);
    expect((await list(kuba, `added_by=${ola.id}`)).total).toBe(1);

    await h.app.inject({ method: 'POST', url: `/places/${b}/gold-star`, headers: ola.headers });
    expect(names(await list(kuba, 'gold_only=true'))).toEqual(['Bar Pod Pionem']);

    // Ola has rated only her own place.
    expect(names(await list(ola, 'unrated_only=true')).sort()).toEqual(['Bar Pod Pionem', 'Pawilon Nocny']);
    await h.app.inject({ method: 'PUT', url: `/places/${a}/saved`, headers: ola.headers });
    expect(names(await list(ola, 'saved_only=true'))).toEqual(['Pawilon Nocny']);
  });

  it('filters by distance and map viewport', async () => {
    const { kuba } = await seed();
    const near = await list(kuba, `${center}&radius_m=2000&sort=nearest`);
    expect(names(near)).toEqual(['Bar Pod Pionem', 'Pawilon Nocny']);
    expect(near.items[0]!.distance_m).toBe(0);
    expect(near.items[1]!.distance_m).toBeGreaterThan(400);
    expect(near.items[1]!.distance_m).toBeLessThan(600);

    expect(names(await list(kuba, 'bbox=20.85,52.1,21.25,52.37&limit=500')).sort()).toEqual([
      'Bar Pod Pionem',
      'Pawilon Nocny',
    ]);
    expect((await list(kuba, 'bbox=0,0,1,1')).total).toBe(0);
    const bad = await h.app.inject({ method: 'GET', url: '/places?bbox=21.2,52.1,20.8,52.3', headers: kuba.headers });
    expect(bad.statusCode).toBe(422);
    const noOrigin = await h.app.inject({ method: 'GET', url: '/places?sort=nearest', headers: kuba.headers });
    expect(noOrigin.statusCode).toBe(422);
  });

  it('hides closed places unless asked', async () => {
    const { kuba, b } = await seed();
    await h.app.inject({ method: 'PATCH', url: `/places/${b}`, headers: kuba.headers, payload: { status: 'closed' } });
    expect((await list(kuba, '')).total).toBe(2);
    expect((await list(kuba, 'include_closed=true')).total).toBe(3);
    // Still reachable directly.
    expect((await h.app.inject({ method: 'GET', url: `/places/${b}`, headers: kuba.headers })).json().status).toBe(
      'closed',
    );
  });

  it('sorts by comments and newest, and pages with a cursor', async () => {
    const { kuba, a, b, c } = await seed();
    await h.app.inject({
      method: 'POST',
      url: `/places/${b}/comments`,
      headers: kuba.headers,
      payload: { body: 'Super' },
    });
    expect((await list(kuba, 'sort=most_commented')).items[0]!.id).toBe(b);
    expect((await list(kuba, 'sort=newest')).items.map((p) => p.id)).toEqual([c, b, a]);

    const first = await list(kuba, 'sort=newest&limit=2');
    expect(first.items.map((p) => p.id)).toEqual([c, b]);
    expect(first.total).toBe(3);
    const second = await list(kuba, `sort=newest&limit=2&cursor=${first.next_cursor}`);
    expect(second.items.map((p) => p.id)).toEqual([a]);
    expect(second.next_cursor).toBeNull();
    const bad = await h.app.inject({ method: 'GET', url: '/places?cursor=nope', headers: kuba.headers });
    expect(bad.json().error).toBe('invalid_input');
  });

  it('uses the spatial and text indexes', async () => {
    const plan = async (where: string, order = '') =>
      (
        await h.sql.begin(async (tx) => {
          await tx`set local enable_seqscan = off`;
          return tx.unsafe(`explain select id from places where ${where} ${order}`);
        })
      )
        .map((r) => r['QUERY PLAN'] as string)
        .join('\n');
    const here = 'ST_SetSRID(ST_MakePoint(21.01, 52.23), 4326)::geography';
    expect(await plan(`ST_DWithin(geom::geography, ${here}, 2000)`)).toContain('places_geog_idx');
    expect(await plan('geom && ST_MakeEnvelope(20.9, 52.1, 21.1, 52.3, 4326)')).toContain('places_geom_idx');
    expect(await plan('true', `order by geom::geography <-> ${here} limit 5`)).toContain('places_geog_idx');
    expect(await plan("search_text like '%pionem%'")).toContain('places_search_trgm_idx');
  });
});

describe('editing places', () => {
  it('the author or an admin edits and deletes; others cannot', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const admin = await login(h.app, ADMIN);
    const id = await createPlace(h.app, kuba, pawilon);
    const patch = (who: typeof kuba, payload: object) =>
      h.app.inject({ method: 'PATCH', url: `/places/${id}`, headers: who.headers, payload });

    const denied = await patch(ola, { name: 'Mój Pawilon' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('not_authorized');

    const ok = await patch(kuba, { price_level: 3, tags: ['Jazz'], status: 'temporarily_closed' });
    expect(ok.json()).toMatchObject({ price_level: 3, tags: ['Jazz'], status: 'temporarily_closed' });
    expect((await patch(admin, { category_id: 'bar' })).json().category_id).toBe('bar');

    expect((await h.app.inject({ method: 'DELETE', url: `/places/${id}`, headers: ola.headers })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: `/places/${id}`, headers: admin.headers })).statusCode).toBe(
      204,
    );
    const gone = await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: kuba.headers });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe('not_found');
  });

  it('saves places for later', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, ola, pawilon);
    await createPlace(h.app, ola, podPionem);

    expect((await h.app.inject({ method: 'PUT', url: `/places/${id}/saved`, headers: ola.headers })).json()).toEqual({
      is_saved: true,
    });
    await h.app.inject({ method: 'PUT', url: `/places/${id}/saved`, headers: ola.headers }); // idempotent
    const saved = (await h.app.inject({ method: 'GET', url: '/me/saved', headers: ola.headers })).json();
    expect(saved.items.map((p: { id: string; is_saved: boolean }) => [p.id, p.is_saved])).toEqual([[id, true]]);

    await h.app.inject({ method: 'DELETE', url: `/places/${id}/saved`, headers: ola.headers });
    expect((await h.app.inject({ method: 'GET', url: '/me/saved', headers: ola.headers })).json().total).toBe(0);
  });
});

describe('card style', () => {
  it('defaults to the app’s rotation, no filter and full strength', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = await createPlace(h.app, kuba, pawilon);
    const res = await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: kuba.headers });
    expect(res.json().card_style).toEqual({ layout: 'auto', photo_filter: 'none', filter_intensity: 100, color: null });
  });

  it('is set by the author when adding and editing, and shown to everyone in lists', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const res = await h.app.inject({
      method: 'POST',
      url: '/places',
      headers: kuba.headers,
      payload: {
        ...pawilon,
        rating: { vibe: 5, offer: 4 },
        photo_ids: [await photoId(h.app, kuba)],
        card_style: { layout: 'c', photo_filter: 'duotone', filter_intensity: 60, color: 'teal' },
      },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect(res.json().card_style).toEqual({
      layout: 'c',
      photo_filter: 'duotone',
      filter_intensity: 60,
      color: 'teal',
    });

    const patch = (who: typeof kuba, card_style: object) =>
      h.app.inject({ method: 'PATCH', url: `/places/${id}`, headers: who.headers, payload: { card_style } });
    expect((await patch(ola, { photo_filter: 'riso' })).statusCode).toBe(403);
    const edited = await patch(kuba, { photo_filter: 'riso' });
    expect(edited.json().card_style).toEqual({
      layout: 'c',
      photo_filter: 'riso',
      filter_intensity: 60,
      color: 'teal',
    });
    // null brings back the category's colour; unknown colours are rejected.
    expect((await patch(kuba, { color: null })).json().card_style.color).toBeNull();
    expect((await patch(kuba, { color: 'gold' })).statusCode).toBe(422);
    await patch(kuba, { color: 'teal' });
    expect((await patch(kuba, { filter_intensity: 101 })).statusCode).toBe(422);
    expect((await patch(kuba, { layout: 'd' })).statusCode).toBe(422);
    const wedge = await patch(kuba, { layout: 'wedge', photo_filter: 'sunset' });
    expect(wedge.statusCode).toBe(200);
    expect(wedge.json().card_style).toMatchObject({ layout: 'wedge', photo_filter: 'sunset' });
    await patch(kuba, { layout: 'c', photo_filter: 'riso' });

    const list = await h.app.inject({ method: 'GET', url: '/places', headers: ola.headers });
    const item = list.json().items.find((p: { id: string }) => p.id === id);
    expect(item.card_style).toEqual({ layout: 'c', photo_filter: 'riso', filter_intensity: 60, color: 'teal' });
  });
});
