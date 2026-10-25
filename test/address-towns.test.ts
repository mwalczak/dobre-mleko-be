import { describe, expect, it } from 'vitest';
import { fillAddressTowns, townAt, withTown } from '../src/address-towns.js';
import { createPlace, login, pawilon, setup } from './helpers.js';

const h = setup();

/** Fake Nominatim: the town by latitude; `null` answers 503. */
function nominatim(towns: Record<string, Record<string, string> | null>) {
  const urls: string[] = [];
  const fake: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const address = towns[url.searchParams.get('lat')!];
    if (address === null) return new Response('busy', { status: 503 });
    return Response.json({ address: address ?? {} });
  };
  return { fake, urls };
}

describe('address towns', () => {
  it('adds the town unless it is already there or would not fit', () => {
    expect(withTown('Węgłowa 4', 'Warszawa')).toBe('Węgłowa 4, Warszawa');
    expect(withTown('Hustopeče nad Bečvou 332', 'Hustopeče nad Bečvou')).toBe('Hustopeče nad Bečvou 332');
    expect(withTown('Rynek 1 kraków', 'Kraków')).toBe('Rynek 1 kraków');
    expect(withTown('Węgłowa 4', null)).toBe('Węgłowa 4');
    expect(withTown('x'.repeat(195), 'Warszawa')).toBe('x'.repeat(195));
  });

  it('reads city, town or village from Nominatim, not the gmina', async () => {
    const { fake, urls } = nominatim({
      '1': { city: 'Warszawa' },
      '2': { town: 'Konstancin-Jeziorna' },
      '3': { village: 'Jurata' },
      '4': { road: 'Polna', municipality: 'gmina Jastarnia' },
      '5': null,
    });
    expect(await townAt(1, 21, fake)).toBe('Warszawa');
    expect(await townAt(2, 21, fake)).toBe('Konstancin-Jeziorna');
    expect(await townAt(3, 21, fake)).toBe('Jurata');
    expect(await townAt(4, 21, fake)).toBeNull();
    expect(await townAt(5, 21, fake)).toBeUndefined();
    expect(urls[0]).toContain('nominatim.openstreetmap.org/reverse');
    expect(urls[0]).toContain('accept-language=pl');
  });

  it('fills towns in places and wishlist items once, and leaves the rest when Nominatim is down', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const short = await createPlace(h.app, ola, {
      ...pawilon,
      name: 'Akita Ramen',
      address: 'Węgłowa 4',
      location: { lat: 52.1, lng: 21 },
    });
    const full = await createPlace(h.app, ola, {
      ...pawilon,
      name: 'Pełny',
      address: 'Nowy Świat 6, Warszawa',
      location: { lat: 52.2, lng: 21 },
    });
    const later = await createPlace(h.app, ola, {
      ...pawilon,
      name: 'Później',
      address: 'Chmielna 5',
      location: { lat: 52.3, lng: 21 },
    });
    const wish = await h.app.inject({
      method: 'POST',
      url: '/me/wishlist',
      headers: ola.headers,
      payload: { name: 'Bar', lat: 52.4, lng: 21, address: 'Polna 1' },
    });
    const address = async (table: string, id: string) =>
      (await h.sql`select address from ${h.sql(table)} where id = ${id}`)[0]!.address;

    // Nominatim answers the first and fails the second: the run stops there.
    const down = nominatim({ '52.1': { city: 'Warszawa' }, '52.3': null });
    expect(await fillAddressTowns(h.sql, { intervalMs: 0, fetch: down.fake })).toBe(1);
    expect(await address('places', short)).toBe('Węgłowa 4, Warszawa');
    expect(await address('places', full)).toBe('Nowy Świat 6, Warszawa');
    expect(await address('places', later)).toBe('Chmielna 5');
    expect(down.urls).toHaveLength(2);

    const up = nominatim({ '52.3': { city: 'Warszawa' }, '52.4': { village: 'Jurata' } });
    expect(await fillAddressTowns(h.sql, { intervalMs: 0, fetch: up.fake })).toBe(2);
    expect(await address('places', later)).toBe('Chmielna 5, Warszawa');
    expect(await address('wishlist_items', wish.json().id)).toBe('Polna 1, Jurata');
    // Only unchecked rows: the first place is not asked about again.
    expect(up.urls).toHaveLength(2);

    // Each row once: a later run asks nothing, even if someone shortens an address on purpose.
    await h.sql`update places set address = 'Węgłowa 4' where id = ${short}`;
    const again = nominatim({});
    expect(await fillAddressTowns(h.sql, { intervalMs: 0, fetch: again.fake })).toBe(0);
    expect(again.urls).toHaveLength(0);
  });
});
