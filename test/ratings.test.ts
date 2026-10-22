import { describe, expect, it } from 'vitest';
import { ADMIN, createPlace, kreska, login, pawilon, photoId, podPionem, rate, setup, type Who } from './helpers.js';

const h = setup();

const put = (who: Who, placeId: string, payload: object) =>
  h.app.inject({ method: 'PUT', url: `/places/${placeId}/rating`, headers: who.headers, payload });

describe('ratings', () => {
  it('every rating needs at least one photo', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, kuba, pawilon);

    const without = await put(ola, id, { vibe: 4, offer: 4 });
    expect(without.statusCode).toBe(422);
    expect(without.json().error).toBe('invalid_input');

    const withPhoto = await rate(h.app, ola, id, { vibe: 4, offer: 4 });
    expect(withPhoto.statusCode).toBe(200);
    expect(withPhoto.json().photos).toHaveLength(2); // Kuba's and Ola's

    // Changing the scores later does not need new photos.
    expect((await put(ola, id, { vibe: 5, offer: 5 })).statusCode).toBe(200);
  });

  it('averages only the criteria that apply', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = await createPlace(h.app, kuba, pawilon, { vibe: 5, offer: 4, service: 4, value: null });
    const place = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: kuba.headers })).json();
    expect(place).toMatchObject({ rating_avg: 4.33, rating_count: 1, my_rating: 4.33 });
  });

  it('validates scores', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = await createPlace(h.app, kuba, pawilon);
    expect((await put(kuba, id, { vibe: 5 })).statusCode).toBe(422);
    expect((await put(kuba, id, { vibe: 6, offer: 4 })).statusCode).toBe(422);
    expect((await put(kuba, id, { vibe: 0, offer: 4 })).statusCode).toBe(422);
  });

  it('one rating per person, with breakdown and distribution', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const id = await createPlace(h.app, kuba, pawilon, { vibe: 5, offer: 4, service: 3 }); // overall 4
    await rate(h.app, ola, id, { vibe: 3, offer: 3 });
    await put(ola, id, { vibe: 2, offer: 2 }); // replaces Ola's: overall 2
    await rate(h.app, tomek, id, { vibe: 5, offer: 5, service: 5, value: 4 }); // 4.75

    const place = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: ola.headers })).json();
    expect(place.rating_count).toBe(3);
    expect(place.criteria).toEqual([
      { key: 'vibe', average: 4, count: 3 },
      { key: 'offer', average: 3.67, count: 3 },
      { key: 'service', average: 4, count: 2 },
      { key: 'value', average: 4, count: 1 },
    ]);
    expect(place.strongest_criterion).toBe('vibe');
    expect(place.rating_distribution).toEqual({ 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 });
    expect(place.my_scores).toEqual({ vibe: 2, offer: 2, service: null, value: null });

    const mine = (await h.app.inject({ method: 'GET', url: '/me/ratings', headers: ola.headers })).json();
    expect(mine).toMatchObject({
      total: 1,
      next_cursor: null,
      items: [{ overall: 2, place: { id, category_id: 'club' } }],
    });
  });

  it('a rating holds at most max_photos_per_rating photos', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = await createPlace(h.app, kuba, pawilon); // 1 photo
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => photoId(h.app, kuba)));
    expect((await put(kuba, id, { vibe: 4, offer: 4, photo_ids: five })).json().photos).toHaveLength(6);
    const seventh = await put(kuba, id, { vibe: 4, offer: 4, photo_ids: [await photoId(h.app, kuba)] });
    expect(seventh.statusCode).toBe(409);
    expect(seventh.json().error).toBe('too_many_photos');
  });

  it('removing a rating removes its photos', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, kuba, pawilon);
    await rate(h.app, ola, id, { vibe: 3, offer: 3 });

    const res = await h.app.inject({ method: 'DELETE', url: `/places/${id}/rating`, headers: ola.headers });
    expect(res.json()).toMatchObject({ my_rating: null, my_scores: null, rating_count: 1 });
    expect(res.json().photos.map((p: { uploaded_by: string }) => p.uploaded_by)).toEqual([kuba.id]);
  });

  it('ranks by rank_score: few ratings pull towards the average, gold stars add a bonus', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const a = await createPlace(h.app, ola, pawilon, { vibe: 5, offer: 5 });
    const b = await createPlace(h.app, ola, podPionem, { vibe: 5, offer: 5 });
    const c = await createPlace(h.app, ola, kreska, { vibe: 2, offer: 2 });
    for (const who of [kuba, tomek]) {
      await rate(h.app, who, a, { vibe: 5, offer: 5 });
      await rate(h.app, who, c, { vibe: 2, offer: 2 });
    }
    // a: three 5s, b: one 5, c: three 2s. One lone 5 must not beat three of them.
    const order = async () =>
      (await h.app.inject({ method: 'GET', url: '/places?sort=best', headers: ola.headers }))
        .json()
        .items.map((p: { id: string }) => p.id);
    expect(await order()).toEqual([a, b, c]);

    // a = 4.357, b = 4.036 (network average 3.71); three gold stars (+0.15 each) lift b to 4.486, over a.
    for (const who of [ola, kuba, tomek]) {
      await h.app.inject({ method: 'POST', url: `/places/${b}/gold-star`, headers: who.headers });
    }
    expect(await order()).toEqual([b, a, c]);
    const b2 = (await h.app.inject({ method: 'GET', url: `/places/${b}`, headers: ola.headers })).json();
    expect(b2.rating_avg).toBe(5); // stars do not change the average
  });
});

describe('gold stars', () => {
  it('three a month, once per place per month', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await createPlace(h.app, ola, { ...pawilon, name: `Miejsce ${i}` }));
    const star = (id: string) => h.app.inject({ method: 'POST', url: `/places/${id}/gold-star`, headers: ola.headers });

    expect((await star(ids[0]!)).json()).toEqual({ awarded: true, gold_stars_left: 2 });
    const again = await star(ids[0]!);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('gold_star_already_awarded');
    await star(ids[1]!);
    await star(ids[2]!);
    const fourth = await star(ids[3]!);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error).toBe('no_gold_stars_left');
    expect((await h.app.inject({ method: 'GET', url: '/me/gold-stars', headers: ola.headers })).json()).toEqual({
      per_month: 3,
      left: 0,
      month: '2026-10-01',
    });

    const undo = await h.app.inject({ method: 'DELETE', url: `/places/${ids[2]}/gold-star`, headers: ola.headers });
    expect(undo.json()).toEqual({ awarded: false, gold_stars_left: 1 });
    expect((await star(ids[3]!)).statusCode).toBe(200);
  });

  it('can be taken back only in its month, and renews next month', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = await createPlace(h.app, ola, pawilon);
    await h.app.inject({ method: 'POST', url: `/places/${id}/gold-star`, headers: kuba.headers });

    let place = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: kuba.headers })).json();
    expect(place).toMatchObject({ gold_star_count: 1, gold_stars_this_month: 1, can_revoke_gold_star: true });
    expect(place.gold_star_awarders.map((p: { id: string }) => p.id)).toEqual([kuba.id]);

    h.clock.now = new Date('2026-11-02T10:00:00Z');
    place = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: kuba.headers })).json();
    expect(place).toMatchObject({
      gold_star_count: 1,
      gold_stars_this_month: 0,
      my_gold_star: null,
      can_revoke_gold_star: false,
      gold_stars_left: 3,
    });
    const late = await h.app.inject({ method: 'DELETE', url: `/places/${id}/gold-star`, headers: kuba.headers });
    expect(late.json().error).toBe('gold_star_revoke_window_passed');
    expect(
      (await h.app.inject({ method: 'DELETE', url: `/places/${id}/gold-star`, headers: ola.headers })).statusCode,
    ).toBe(404);

    expect(
      (await h.app.inject({ method: 'POST', url: `/places/${id}/gold-star`, headers: kuba.headers })).statusCode,
    ).toBe(200);
  });

  it('cannot be overrun by concurrent requests', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await createPlace(h.app, ola, { ...pawilon, name: `Miejsce ${i}` }));
    await Promise.all(
      ids.map((id) => h.app.inject({ method: 'POST', url: `/places/${id}/gold-star`, headers: ola.headers })),
    );
    const [{ n }] = await h.sql<[{ n: number }]>`select count(*)::int as n from stars`;
    expect(n).toBe(3);
  });

  it('the bonus per star is an admin setting', async () => {
    const admin = await login(h.app, ADMIN);
    const res = await h.app.inject({
      method: 'PUT',
      url: '/admin/settings/starRankBonus',
      headers: admin.headers,
      payload: { value: 0.5 },
    });
    expect(res.json()).toMatchObject({ value: 0.5, integer: false });
  });
});

describe('photo order', () => {
  const order = (who: Who, placeId: string, photo_ids: string[]) =>
    h.app.inject({
      method: 'PUT',
      url: `/places/${placeId}/photos/order`,
      headers: who.headers,
      payload: { photo_ids },
    });
  const photosOf = async (who: Who, placeId: string) => {
    const place = (await h.app.inject({ method: 'GET', url: `/places/${placeId}`, headers: who.headers })).json();
    return { ids: place.photos.map((p: { id: string }) => p.id) as string[], cover: place.cover_photo?.id as string };
  };

  it('the author reorders all photos of the place; the first one becomes the cover', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, kuba, pawilon);
    expect((await put(ola, id, { vibe: 4, offer: 4, photo_ids: [await photoId(h.app, ola)] })).statusCode).toBe(200);
    const [first, second] = (await photosOf(kuba, id)).ids;

    expect((await order(kuba, id, [second!, first!])).statusCode).toBe(204);
    expect(await photosOf(ola, id)).toEqual({ ids: [second, first], cover: second });
    const list = (await h.app.inject({ method: 'GET', url: '/places', headers: kuba.headers })).json();
    expect(list.items.find((p: { id: string }) => p.id === id).cover_photo.id).toBe(second);

    // Photos added later go to the end.
    const later = await photoId(h.app, ola);
    expect((await put(ola, id, { vibe: 4, offer: 4, photo_ids: [later] })).statusCode).toBe(200);
    expect((await photosOf(kuba, id)).ids).toEqual([second, first, later]);
  });

  it('only the author or an admin, and only with every photo of the place exactly once', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const admin = await login(h.app, ADMIN);
    const id = await createPlace(h.app, kuba, pawilon);
    expect((await put(ola, id, { vibe: 4, offer: 4, photo_ids: [await photoId(h.app, ola)] })).statusCode).toBe(200);
    const [first, second] = (await photosOf(kuba, id)).ids;

    expect((await order(ola, id, [second!, first!])).statusCode).toBe(403);
    expect((await order(admin, id, [second!, first!])).statusCode).toBe(204);
    expect((await order(kuba, id, [first!])).statusCode).toBe(422);
    expect((await order(kuba, id, [first!, first!])).statusCode).toBe(422);
    const elsewhere = await createPlace(h.app, kuba, kreska);
    const foreign = (await photosOf(kuba, elsewhere)).ids[0]!;
    expect((await order(kuba, id, [first!, foreign])).statusCode).toBe(422);
    expect((await photosOf(kuba, id)).ids).toEqual([second, first]);
  });
});
