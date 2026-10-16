import { describe, expect, it } from 'vitest';
import { createPlace, login, pawilon, rate, setup, type Who } from './helpers.js';

const h = setup();

const jachta = {
  name: 'Výletní restaurant Jachta',
  lat: 49.5254551,
  lng: 17.8519913,
  address: 'Hustopeče nad Bečvou 332',
  description: 'Na rowerach nad Bečvą',
  url: 'https://maps.app.goo.gl/xTag6qQGCPnVboTDA',
};
const zamek = { name: 'Zamek Książ', lat: 50.8423, lng: 16.2919 };

const add = (who: Who, payload: object) =>
  h.app.inject({ method: 'POST', url: '/me/wishlist', headers: who.headers, payload });
const patch = (who: Who, id: string, payload: object) =>
  h.app.inject({ method: 'PATCH', url: `/me/wishlist/${id}`, headers: who.headers, payload });
const get = (who: Who, url: string) => h.app.inject({ method: 'GET', url, headers: who.headers });

describe('wishlist', () => {
  it('adds an item with name, point, description and link', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const res = await add(kuba, jachta);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      ...jachta,
      visited_on: null,
      place_id: null,
      is_mine: true,
      owner: { id: kuba.id, display_name: 'Kuba' },
      updated_at: null,
    });
  });

  it('validates the fields', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    expect((await add(kuba, { ...zamek, name: '  ' })).statusCode).toBe(422);
    expect((await add(kuba, { ...zamek, lat: 91 })).statusCode).toBe(422);
    expect((await add(kuba, { ...zamek, url: 'javascript:alert(1)' })).statusCode).toBe(422);
    expect((await add(kuba, { ...zamek, description: 'x'.repeat(1001) })).statusCode).toBe(422);
    // Empty optional text is stored as null.
    const blank = await add(kuba, { ...zamek, url: '', description: '' });
    expect(blank.json()).toMatchObject({ url: null, description: null });
  });

  it('everyone sees everyone’s list; only the owner changes it', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const id = (await add(kuba, jachta)).json().id;

    const list = (await get(ola, `/members/${kuba.id}/wishlist`)).json();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id, is_mine: false });
    expect((await get(ola, `/wishlist/${id}`)).json().name).toBe(jachta.name);

    expect((await patch(ola, id, { name: 'Moja' })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: `/me/wishlist/${id}`, headers: ola.headers })).statusCode).toBe(
      403,
    );
    expect((await get(ola, '/members/00000000-0000-4000-8000-000000000000/wishlist')).statusCode).toBe(404);

    const deleted = await h.app.inject({ method: 'DELETE', url: `/me/wishlist/${id}`, headers: kuba.headers });
    expect(deleted.statusCode).toBe(204);
    expect((await get(kuba, `/wishlist/${id}`)).statusCode).toBe(404);
  });

  it('marks visited with a date (not in the future) and links the place it became', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = (await add(kuba, jachta)).json().id;
    await add(kuba, zamek);

    expect((await patch(kuba, id, { visited_on: '2026-10-12' })).statusCode).toBe(422); // clock: 2026-10-11
    const visited = await patch(kuba, id, { visited_on: '2026-10-10' });
    expect(visited.json()).toMatchObject({ visited_on: '2026-10-10', name: jachta.name });
    expect(visited.json().updated_at).not.toBeNull();

    // Not yet visited first.
    const all = (await get(kuba, '/me/wishlist')).json();
    expect(all.items.map((i: { name: string }) => i.name)).toEqual([zamek.name, jachta.name]);
    expect((await get(kuba, '/me/wishlist?visited=true')).json().total).toBe(1);
    expect((await get(kuba, '/me/wishlist?visited=false')).json().items[0].name).toBe(zamek.name);

    const placeId = await createPlace(h.app, kuba, pawilon);
    expect((await patch(kuba, id, { place_id: placeId })).json().place_id).toBe(placeId);
    expect((await patch(kuba, id, { place_id: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);

    // Cleared again.
    expect((await patch(kuba, id, { visited_on: null })).json().visited_on).toBeNull();
  });

  it('map layer: everyone’s not yet visited items in the viewport', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    await add(kuba, jachta);
    const olaZamek = (await add(ola, zamek)).json().id;
    await add(ola, { name: 'Daleko', lat: 40, lng: -3 });

    const poland = '14,50,24.5,55';
    const czechiaAndPoland = '12,48,24.5,55';
    expect((await get(kuba, `/wishlist?bbox=${poland}`)).json().items.map((i: { id: string }) => i.id)).toEqual([
      olaZamek,
    ]);
    expect((await get(kuba, `/wishlist?bbox=${czechiaAndPoland}`)).json().total).toBe(2);

    await patch(ola, olaZamek, { visited_on: '2026-10-01' });
    expect((await get(kuba, `/wishlist?bbox=${poland}`)).json().total).toBe(0);
    expect((await get(kuba, `/wishlist?bbox=${poland}&visited=true`)).json().total).toBe(1);
    expect((await get(kuba, '/wishlist?bbox=1,2,3')).statusCode).toBe(422);
  });

  it('deleting the account removes the wishlist', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    await add(kuba, jachta);
    await h.app.inject({ method: 'DELETE', url: '/me', headers: kuba.headers });
    const [row] = await h.sql<{ n: number }[]>`select count(*)::int as n from wishlist_items`;
    expect(row!.n).toBe(0);
  });
});

describe('visit date on ratings', () => {
  const put = (who: Who, placeId: string, payload: object) =>
    h.app.inject({ method: 'PUT', url: `/places/${placeId}/rating`, headers: who.headers, payload });

  it('is optional, kept when left out, cleared with null, never in the future', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, kuba, pawilon);

    const rated = await rate(h.app, ola, id, { vibe: 4, offer: 4, visited_on: '2026-10-05' });
    expect(rated.json().my_visited_on).toBe('2026-10-05');

    // Changing scores keeps the date.
    expect((await put(ola, id, { vibe: 5, offer: 5 })).json().my_visited_on).toBe('2026-10-05');
    expect((await put(ola, id, { vibe: 5, offer: 5, visited_on: '2026-10-12' })).statusCode).toBe(422);

    const mine = (await get(ola, '/me/ratings')).json();
    expect(mine.items[0].visited_on).toBe('2026-10-05');

    expect((await put(ola, id, { vibe: 5, offer: 5, visited_on: null })).json().my_visited_on).toBeNull();
    // Others never see it.
    expect((await get(kuba, `/places/${id}`)).json().my_visited_on).toBeNull();
  });
});
