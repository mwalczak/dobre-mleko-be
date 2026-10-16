// Fixtures for local development: 10 members and 100 Warsaw places with ratings, photos, gold stars, comments and
// saved places. Deterministic (same data on every run). Refuses to run in production.
//
//   npm run seed            # into an empty database
//   npm run seed -- --reset # wipe content and users first
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ensureAdmins } from './auth.js';
import { createDb, migrate, type Sql } from './db.js';
import { DEFAULT_CATEGORIES, localDate, monthStart, type DefaultCategory } from './domain.js';
import { PhotoStore, processImage, sha256 } from './photo-store.js';

export interface SeedOptions {
  places?: number;
  timeZone?: string;
  now?: Date;
  /** Extra admins (e.g. ADMIN_EMAILS) so the developer's own Google account works too. */
  admins?: string[];
}

export const SEED_USERS = [
  { email: 'marta@example.com', name: 'Marta', badge: 'Mleczarka', role: 'admin', fav: ['coffee', 'culture'] },
  { email: 'kuba@example.com', name: 'Kuba', badge: 'Muala', role: 'member', fav: ['club', 'bar'] },
  { email: 'ola@example.com', name: 'Ola', badge: null, role: 'member', fav: ['food', 'kids'] },
  { email: 'tomek@example.com', name: 'Tomek', badge: 'Tomasz z Woli', role: 'member', fav: ['sport'] },
  { email: 'ewa@example.com', name: 'Ewa', badge: 'EwelaRewela', role: 'member', fav: ['nature', 'coffee'] },
  { email: 'adam@example.com', name: 'Adam', badge: 'SzachMat', role: 'member', fav: ['bar', 'food', 'culture'] },
  { email: 'piotr@example.com', name: 'Piotr', badge: 'Szef Kuchni', role: 'member', fav: ['food'] },
  { email: 'hania@example.com', name: 'Hania', badge: 'Hanka', role: 'member', fav: ['kids', 'nature'] },
  { email: 'zosia@example.com', name: 'Zosia', badge: null, role: 'member', fav: ['shopping', 'coffee'] },
  { email: 'filip@example.com', name: 'Filip', badge: 'Filo', role: 'member', fav: ['club'] },
] as const;

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const sample = <T>(xs: readonly T[], n: number): T[] => {
    const copy = [...xs];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy.slice(0, n);
  };
  return { next, int, pick, sample, chance: (p: number) => next() < p };
}

const NAMES: Record<DefaultCategory, { prefix: string[]; suffix: string[]; tags: string[]; about: string[] }> = {
  food: {
    prefix: ['Bistro', 'Jadłodajnia', 'Pierogarnia', 'Trattoria', 'Bar mleczny', 'Kuchnia'],
    suffix: ['Pod Lipą', 'Na Rogu', 'Stary Młyn', 'Smakosz', 'Babcia Zosia', 'Warszawianka', 'Pełny Talerz'],
    tags: ['Na lunch', 'Wege', 'Domowe', 'Duże porcje', 'Ogródek', 'Na randkę'],
    about: [
      'Pierogi jak u babci i zupa dnia za grosze.',
      'Krótka karta, wszystko świeże.',
      'Najlepszy schabowy na Pradze.',
    ],
  },
  coffee: {
    prefix: ['Kawiarnia', 'Palarnia', 'Kafejka', 'Espresso Bar'],
    suffix: ['Ostra Kreska', 'Ziarno', 'Filiżanka', 'Pod Kasztanem', 'Mleko i Miód', 'Poranek', 'Czarny Kot'],
    tags: ['Do pracy', 'Wi-Fi', 'Ciasta', 'Przelewowa', 'Cicho', 'Śniadania'],
    about: [
      'Kawa z własnej palarni, sernik obłędny.',
      'Dobre miejsce do pracy z laptopem.',
      'Mała, ale z charakterem.',
    ],
  },
  bar: {
    prefix: ['Bar', 'Pub', 'Winiarnia', 'Piwiarnia', 'Koktajlbar'],
    suffix: ['Pod Pionem', 'Na Zdrowie', 'Kufel', 'Kruk', 'Stara Fabryka', 'Pod Strzechą', 'Ostatni Dzwonek'],
    tags: ['Piwo kraftowe', 'Koktajle', 'Późno w nocy', 'Ogródek', 'Mecze', 'Tanio'],
    about: ['Kraft z małych browarów i dobre zakąski.', 'Koktajle robione z głową.', 'Głośno, tłoczno i świetnie.'],
  },
  club: {
    prefix: ['Klub', 'Pawilon', 'Scena', 'Piwnica'],
    suffix: ['Nocny', 'Pod Ziemią', 'Basowa', 'Hala 7', 'Neon', 'Echo', 'Puls'],
    tags: ['Techno', 'Muzyka na żywo', 'Jazz', 'Późno w nocy', 'Selekcja'],
    about: [
      'W czwartki jazz od 21:00, w piątki techno do rana.',
      'Najlepszy dźwięk w mieście.',
      'Wejście od podwórza.',
    ],
  },
  kids: {
    prefix: ['Plac Zabaw', 'Bawialnia', 'Klub Malucha', 'Park Linowy'],
    suffix: ['Trzy Koła', 'Wesoła Żaba', 'Bajka', 'Huśtawka', 'Mały Odkrywca', 'Kolorowo'],
    tags: ['Dla maluchów', 'Zadaszone', 'Kawiarnia dla rodziców', 'Urodziny', 'Bezpłatne'],
    about: ['Ogrodzony, z piaskownicą i cieniem.', 'Dzieci nie chcą wychodzić.', 'Dobra kawa dla rodziców obok.'],
  },
  culture: {
    prefix: ['Muzeum', 'Galeria', 'Teatr', 'Kino', 'Teatrzyk'],
    suffix: ['Neonów', 'Kółko', 'Iluzjon', 'Na Woli', 'Studio', 'Mała Scena', 'Pod Gwiazdami'],
    tags: ['Wystawy', 'Spektakle', 'Kino studyjne', 'Dla dzieci', 'Bezpłatne w czwartki'],
    about: ['Mała sala, wielkie przeżycia.', 'Wystawy zmieniają się co miesiąc.', 'Repertuar bez blockbusterów.'],
  },
  nature: {
    prefix: ['Park', 'Ogród', 'Skwer', 'Rezerwat', 'Polana'],
    suffix: ['Skaryszewski', 'Pod Dębami', 'Nad Wisłą', 'Leśny', 'Zielony Zakątek', 'Morskie Oko'],
    tags: ['Spacer', 'Psy mile widziane', 'Piknik', 'Rower', 'Cień'],
    about: ['Idealny na niedzielny spacer.', 'Cisza w środku miasta.', 'Latem pikniki, zimą sanki.'],
  },
  sport: {
    prefix: ['Ścianka', 'Basen', 'Kort', 'Siłownia', 'Boisko'],
    suffix: ['Wspinalnia', 'Fala', 'Pod Chmurką', 'Olimp', 'Na Mokotowie', 'Kozłówka'],
    tags: ['Karnet', 'Dla początkujących', 'Wieczorem', 'Sauna', 'Na powietrzu'],
    about: ['Przyjazna dla początkujących.', 'Sprzęt w dobrym stanie, tłoczno po 18.', 'Warto zarezerwować wcześniej.'],
  },
  shopping: {
    prefix: ['Targ', 'Hala', 'Księgarnia', 'Sklep', 'Antykwariat'],
    suffix: ['Koszyki', 'Mirowska', 'Na Szembeku', 'Pod Arkadami', 'Lokalny', 'Bazarek'],
    tags: ['Lokalne produkty', 'Vintage', 'Książki', 'Warzywa', 'Weekendy'],
    about: ['Warzywa prosto od rolników.', 'Można przepaść na godzinę.', 'Ceny uczciwe, obsługa zna się na rzeczy.'],
  },
  hotel: {
    prefix: ['Hotel', 'Pensjonat', 'Hostel', 'Apartamenty', 'Willa'],
    suffix: ['Pod Wieżą', 'Stara Kamienica', 'Przy Parku', 'Na Wzgórzu', 'Śródmieście', 'Cicha Noc'],
    tags: ['Śniadania', 'Parking', 'Z psem', 'Widok', 'Basen', 'Blisko centrum'],
    about: ['Ciche pokoje od podwórza i świetne śniadania.', 'Dobra baza na weekend.', 'Obsługa jak w rodzinie.'],
  },
  other: {
    prefix: ['Pracownia', 'Warsztat', 'Studio', 'Punkt'],
    suffix: ['Ceramiki', 'Rowerowy', 'Tatuażu', 'Pod Schodami', 'Na Strychu'],
    tags: ['Warsztaty', 'Na zapisy', 'Rękodzieło', 'Naprawy'],
    about: ['Warsztaty w małych grupach.', 'Naprawią wszystko.', 'Miejsce z duszą.'],
  },
};

const STREETS = [
  'Nowy Świat',
  'Marszałkowska',
  'Hoża',
  'Wilcza',
  'Poznańska',
  'Mokotowska',
  'Puławska',
  'Ząbkowska',
  'Targowa',
  'Francuska',
  'Grochowska',
  'Złota',
  'Chmielna',
  'Krucza',
  'Żurawia',
  'Koszykowa',
  'Saska',
  'Racławicka',
  'Odyńca',
  'Narbutta',
  'Świętokrzyska',
  'Okopowa',
  'Wolska',
  'Inżynierska',
  'Stalowa',
];

const COMMENTS = [
  'Byłam w czwartek, było świetnie.',
  'Trochę za głośno, ale warto.',
  'Obsługa bardzo miła.',
  'Weź gotówkę, karta nie zawsze działa.',
  'Najlepsze miejsce w okolicy!',
  'Ceny poszły w górę, ale jakość ta sama.',
  'Byliśmy z dziećmi, polecam.',
  'W weekend trzeba rezerwować.',
  'Daję gwiazdkę, musisz tam iść.',
  'Kiedyś było lepiej.',
  'Super klimat, wrócę na pewno.',
  'Uwaga, w poniedziałki zamknięte.',
];

// Bauhaus Nowy palette for the generated placeholder photos.
const COLORS = ['#D7301F', '#1D4FA0', '#F2B900', '#141414', '#F1ECE2'];

/** An 800×600 JPEG "photo": a coloured ground with a circle, a square and a triangle. */
async function placeholderPhoto(r: ReturnType<typeof rng>): Promise<Buffer> {
  const [bg, a, b, c] = r.sample(COLORS, 4);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
    <rect width="800" height="600" fill="${bg}"/>
    <circle cx="${r.int(150, 650)}" cy="${r.int(120, 480)}" r="${r.int(80, 200)}" fill="${a}"/>
    <rect x="${r.int(0, 600)}" y="${r.int(0, 400)}" width="${r.int(80, 220)}" height="${r.int(80, 220)}" fill="${b}"/>
    <polygon points="${r.int(300, 800)},${r.int(300, 600)} 800,600 ${r.int(400, 800)},600" fill="${c}"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

const HOURS: Record<DefaultCategory, [string, string] | null> = {
  food: ['11:00', '22:00'],
  coffee: ['08:00', '19:00'],
  bar: ['16:00', '02:00'],
  club: ['21:00', '05:00'],
  kids: ['09:00', '19:00'],
  culture: ['10:00', '20:00'],
  nature: null,
  sport: ['07:00', '22:00'],
  shopping: ['09:00', '18:00'],
  hotel: null,
  other: ['10:00', '18:00'],
};

const clampScore = (x: number) => Math.min(5, Math.max(1, Math.round(x)));
const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * 86400000);

/** Wipes users and all content, including their photo files. Keeps settings. */
/** Wishlist fixtures: in Warsaw and further away (trips). */
const WISHLIST_IDEAS = [
  {
    name: 'Hala Gwardii',
    lat: 52.2384,
    lng: 20.9971,
    address: 'Żelazna 59',
    description: 'Street food w hali',
    url: 'https://halagwardii.pl',
  },
  {
    name: 'Kopiec Powstania Warszawskiego',
    lat: 52.2071,
    lng: 21.0372,
    address: 'Bartycka',
    description: 'Widok na miasto o zachodzie',
    url: null,
  },
  {
    name: 'Neon Muzeum',
    lat: 52.2495,
    lng: 21.0656,
    address: 'Mińska 25',
    description: null,
    url: 'https://neonmuzeum.org',
  },
  { name: 'Plaża Poniatówka', lat: 52.2377, lng: 21.0447, address: null, description: 'Leżaki nad Wisłą', url: null },
  {
    name: 'Zamek Książ',
    lat: 50.8423,
    lng: 16.2919,
    address: 'Piastów Śląskich 1, Wałbrzych',
    description: 'Na weekend',
    url: 'https://ksiaz.walbrzych.pl',
  },
  {
    name: 'Morskie Oko',
    lat: 49.2013,
    lng: 20.0717,
    address: null,
    description: 'Wcześnie rano, zanim dojadą autokary',
    url: null,
  },
  {
    name: 'Výletní restaurant Jachta',
    lat: 49.5254551,
    lng: 17.8519913,
    address: 'Hustopeče nad Bečvou 332',
    description: 'Na rowerach nad Bečvą',
    url: 'https://maps.app.goo.gl/xTag6qQGCPnVboTDA',
  },
  {
    name: 'Mleczarnia Jama Michalika',
    lat: 50.0626,
    lng: 19.9398,
    address: 'Floriańska 45, Kraków',
    description: null,
    url: null,
  },
] as const;

export async function resetData(sql: Sql, store: PhotoStore): Promise<void> {
  const files = await sql<{ hash: string }[]>`
    select hash from place_photos union select avatar_hash from users where avatar_hash is not null
  `;
  await sql`
    truncate users, places, place_photos, ratings, stars, comments, saved_places, wishlist_items, allowed_emails cascade
  `;
  for (const f of files) await store.remove(f.hash);
}

export async function seed(sql: Sql, store: PhotoStore, opts: SeedOptions = {}) {
  const r = rng(42);
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone ?? 'Europe/Warsaw';
  const placeCount = opts.places ?? 100;

  // Members ---------------------------------------------------------------------------------------------------
  const users = SEED_USERS.map((u, i) => ({ ...u, id: randomUUID(), joined: daysAgo(now, 200 - i * 7) }));
  await sql`
    insert into allowed_emails ${sql(users.map((u) => ({ email: u.email, role: u.role, note: 'seed' })))}
  `;
  await sql`
    insert into users ${sql(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        google_sub: `seed:${u.email}`,
        name: u.name,
        badge: u.badge,
        favorite_categories: [...u.fav],
        profile_completed_at: u.joined,
        created_at: u.joined,
        last_seen_at: daysAgo(now, r.int(0, 10)),
      })),
    )}
  `;
  if (opts.admins?.length) await ensureAdmins(sql, opts.admins);

  // Places ----------------------------------------------------------------------------------------------------
  const used = new Set<string>();
  const places: {
    id: string;
    name: string;
    category: DefaultCategory;
    status: string;
    price_level: number | null;
    address: string;
    lat: number;
    lng: number;
    description: string | null;
    tags: string[];
    opening_hours: ReturnType<Sql['json']> | null;
    added_by: string;
    created_at: Date;
    updated_at: Date;
    /** Hidden "true" quality that the ratings scatter around. */
    quality: number;
  }[] = [];
  for (let i = 0; i < placeCount; i++) {
    // Skew towards food, coffee and bars, like real life.
    const category: DefaultCategory = r.chance(0.45)
      ? r.pick(['food', 'coffee', 'bar'] as const)
      : r.pick(DEFAULT_CATEGORIES);
    const n = NAMES[category];
    let name = `${r.pick(n.prefix)} ${r.pick(n.suffix)}`;
    while (used.has(name)) name = `${r.pick(n.prefix)} ${r.pick(n.suffix)} ${r.int(2, 9)}`;
    used.add(name);
    const hours = HOURS[category];
    const author = r.pick(users);
    const created = daysAgo(now, r.int(1, Math.min(180, (now.getTime() - author.joined.getTime()) / 86400000)));
    places.push({
      id: randomUUID(),
      name,
      category,
      status: i % 25 === 7 ? 'closed' : i % 17 === 3 ? 'temporarily_closed' : 'active',
      price_level: category === 'nature' ? null : r.chance(0.85) ? r.int(1, 4) : null,
      address: `ul. ${r.pick(STREETS)} ${r.int(1, 120)}`,
      // Around central Warsaw.
      lat: Math.round((52.18 + r.next() * 0.1) * 1e6) / 1e6,
      lng: Math.round((20.93 + r.next() * 0.17) * 1e6) / 1e6,
      description: r.chance(0.8) ? r.pick(n.about) : null,
      tags: r.sample(n.tags, r.int(0, 3)),
      opening_hours:
        hours && r.chance(0.7)
          ? sql.json(
              [1, 2, 3, 4, 5, 6, ...(r.chance(0.6) ? [0] : [])].map((day) => ({
                day,
                open: hours[0],
                close: hours[1],
              })),
            )
          : null,
      added_by: author.id,
      created_at: created,
      updated_at: created,
      quality: 1.5 + r.next() * 3.5,
    });
  }
  await sql`insert into places ${sql(places.map(({ quality: _q, ...p }) => p))}`;

  // Ratings with photos ---------------------------------------------------------------------------------------
  const ratings: Record<string, unknown>[] = [];
  const photos: Record<string, unknown>[] = [];
  const raters = new Map<string, string[]>();
  for (const p of places) {
    const others = r.sample(
      users.filter((u) => u.id !== p.added_by),
      r.int(1, 6),
    );
    const who = [p.added_by, ...others.map((u) => u.id)];
    raters.set(p.id, who);
    for (const userId of who) {
      const vibe = clampScore(p.quality + (r.next() - 0.5) * 2);
      const offer = clampScore(p.quality + (r.next() - 0.5) * 2);
      const at = new Date(p.created_at.getTime() + r.next() * (now.getTime() - p.created_at.getTime()));
      ratings.push({
        user_id: userId,
        place_id: p.id,
        vibe,
        offer,
        service: p.category === 'nature' || r.chance(0.2) ? null : clampScore(p.quality + (r.next() - 0.5) * 2),
        value: r.chance(0.15) ? null : clampScore(p.quality + (r.next() - 0.5) * 2),
        created_at: at,
        updated_at: at,
      });
      for (let k = 0, n = r.chance(0.3) ? 2 : 1; k < n; k++) {
        const data = await placeholderPhoto(r);
        const hash = sha256(data);
        const image = await processImage(data);
        await store.put(hash, data);
        await store.put(hash, image.thumb, 'thumb');
        photos.push({
          place_id: p.id,
          uploaded_by: userId,
          hash,
          content_type: 'image/jpeg',
          size_bytes: data.length,
          width: image.width,
          height: image.height,
          created_at: at,
        });
      }
    }
  }
  await sql`insert into ratings ${sql(ratings)}`;
  await sql`insert into place_photos ${sql(photos)}`;

  // Gold stars: up to 3 per person per month, this month and the four before --------------------------------
  const stars: Record<string, unknown>[] = [];
  const open = places.filter((p) => p.status !== 'closed');
  for (const u of users) {
    for (let m = 0; m <= 4; m++) {
      const day = new Date(now.getTime());
      day.setUTCDate(15);
      day.setUTCMonth(day.getUTCMonth() - m);
      const month = monthStart(day, timeZone);
      const monthDate = new Date(`${month}T12:00:00Z`);
      if (monthDate < u.joined) continue;
      const given = m === 0 ? Math.min(r.int(0, 3), 2) : r.int(0, 3);
      for (const p of r.sample(open, given)) {
        const at =
          m === 0
            ? daysAgo(now, r.next() * Math.max(0, now.getUTCDate() - 1))
            : new Date(monthDate.getTime() + r.int(0, 20) * 86400000);
        stars.push({ user_id: u.id, place_id: p.id, month, created_at: at });
      }
    }
  }
  if (stars.length) await sql`insert into stars ${sql(stars)}`;

  // Comments, mostly from people who rated the place ----------------------------------------------------------
  const comments: Record<string, unknown>[] = [];
  for (const p of places) {
    for (let k = 0, n = r.int(0, 3); k < n; k++) {
      const by = r.pick(raters.get(p.id)!);
      comments.push({
        place_id: p.id,
        user_id: by,
        body: r.pick(COMMENTS),
        created_at: new Date(p.created_at.getTime() + r.next() * (now.getTime() - p.created_at.getTime())),
      });
    }
  }
  if (comments.length) await sql`insert into comments ${sql(comments)}`;

  // Saved places --------------------------------------------------------------------------------------------
  const saved = users.flatMap((u) =>
    r
      .sample(places, r.int(2, 8))
      .map((p) => ({ user_id: u.id, place_id: p.id, created_at: daysAgo(now, r.int(0, 60)) })),
  );
  await sql`insert into saved_places ${sql(saved)}`;

  // Wishlists: places people want to visit, some already visited ----------------------------------------------
  const wishlist = users.flatMap((u) =>
    r.sample(WISHLIST_IDEAS, r.int(1, 4)).map((idea) => {
      const visited = r.int(0, 3) === 0;
      return {
        user_id: u.id,
        name: idea.name,
        lat: idea.lat,
        lng: idea.lng,
        address: idea.address,
        description: idea.description,
        url: idea.url,
        visited_on: visited ? localDate(daysAgo(now, r.int(3, 90)), timeZone) : null,
        created_at: daysAgo(now, r.int(5, 150)),
      };
    }),
  );
  await sql`insert into wishlist_items ${sql(wishlist)}`;

  return {
    users: users.length,
    places: places.length,
    ratings: ratings.length,
    photos: photos.length,
    stars: stars.length,
    comments: comments.length,
    saved: saved.length,
    wishlist: wishlist.length,
  };
}

// CLI -----------------------------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed in production.');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required (e.g. in .env).');
    process.exit(1);
  }
  const sql = createDb(url);
  const store = new PhotoStore(process.env.PHOTO_DIR ?? './data/photos');
  await migrate(sql);
  const [{ n }] = await sql<[{ n: number }]>`select count(*)::int as n from places`;
  if (process.argv.includes('--reset')) {
    await resetData(sql, store);
  } else if (n > 0) {
    console.error(`The database already has ${n} places. Run with --reset to replace all users and content.`);
    await sql.end();
    process.exit(1);
  }
  const admins = (process.env.ADMIN_EMAILS ?? '')
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const counts = await seed(sql, store, { timeZone: process.env.TIME_ZONE, admins });
  console.log('Seeded:', counts);
  console.log(
    `Members (sign in with POST /auth/dev when DEV_LOGIN=true): ${SEED_USERS.map((u) => u.email).join(', ')}`,
  );
  console.log(`Admin: ${SEED_USERS[0].email}${admins.length ? `, ${admins.join(', ')}` : ''}`);
  await sql.end();
}
