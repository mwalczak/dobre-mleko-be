import type { Sql } from './db.js';

// The Android and iOS apps saved the address under the map pin as street and number only ("Węgłowa 4"); the web
// and newer apps add the town ("Węgłowa 4, Warszawa"). Addresses without a comma get the town from OpenStreetMap
// (Nominatim reverse geocoding, at most one request a second per its usage policy), a batch at a time. Each row is
// looked at once (address_checked_at), so an address someone shortened on purpose stays as they wrote it.

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'DobreMleko/1.0 (https://dobre-mleko.app)';
const MAX_ADDRESS = 200;
const TIMEOUT_MS = 10_000;

/** The town at a point: city, town, village or hamlet (not the gmina); null when there is none, undefined when unknown. */
export async function townAt(
  lat: number,
  lng: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null | undefined> {
  const url = `${NOMINATIM}?${new URLSearchParams({ format: 'jsonv2', lat: String(lat), lon: String(lng), 'accept-language': 'pl' })}`;
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { address?: Record<string, string> };
    const a = body.address ?? {};
    return (a.city ?? a.town ?? a.village ?? a.hamlet)?.trim() || null;
  } catch {
    return undefined;
  }
}

/** "Węgłowa 4" + "Warszawa" → "Węgłowa 4, Warszawa"; unchanged when the town is already there or it would not fit. */
export function withTown(address: string, town: string | null): string {
  if (!town || address.toLocaleLowerCase('pl').includes(town.toLocaleLowerCase('pl'))) return address;
  const full = `${address}, ${town}`;
  return full.length <= MAX_ADDRESS ? full : address;
}

/**
 * Fills in towns for up to `limit` unchecked addresses without a comma (places first, then wishlist items).
 * Stops early when Nominatim does not answer, leaving the rest for the next run. Returns how many changed.
 */
export async function fillAddressTowns(
  sql: Sql,
  opts: { limit?: number; intervalMs?: number; fetch?: typeof fetch } = {},
): Promise<number> {
  const { limit = 50, intervalMs = 1100, fetch: fetchImpl = fetch } = opts;
  let left = limit;
  let changed = 0;
  let first = true;
  for (const table of ['places', 'wishlist_items'] as const) {
    if (left <= 0) break;
    const rows = await sql<{ id: string; address: string; lat: number; lng: number }[]>`
      select id, address, lat, lng from ${sql(table)}
      where address_checked_at is null and address is not null and strpos(address, ',') = 0
      order by created_at
      limit ${left}`;
    for (const row of rows) {
      if (!first) await new Promise((r) => setTimeout(r, intervalMs));
      first = false;
      const town = await townAt(row.lat, row.lng, fetchImpl);
      if (town === undefined) return changed;
      const address = withTown(row.address, town);
      // Only if nobody edited the address meanwhile.
      const [updated] = await sql`
        update ${sql(table)} set address = ${address}, address_checked_at = now()
        where id = ${row.id} and address = ${row.address}
        returning id`;
      if (updated && address !== row.address) changed++;
      left--;
    }
  }
  return changed;
}
