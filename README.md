# dobre-mleko-be

Backend for **Dobre Mleko**: place ratings like Google Maps, but only from friends. Only Google accounts on a
whitelist can sign in; admins manage the whitelist and settings in the admin dashboard of the web app
([dobre-mleko-web](https://github.com/mwalczak/dobre-mleko-web), which also hosts the web version of the app).

Node 22 · TypeScript · Fastify · Postgres 16 with PostGIS, `pg_trgm` and `unaccent` · photos on a volume.

- **API docs:** https://mwalczak.github.io/dobre-mleko-be/ ([`openapi.json`](https://mwalczak.github.io/dobre-mleko-be/openapi.json))
- **Contract:** follows the iOS app's API handoff (`docs/API_HANDOFF.md` in the app repo), without invites and the
  invite tree. Differences are listed under [Contract notes](#contract-notes).

## Quick start

You need Node 22 and Postgres 16 with PostGIS, for example:

```sh
docker run -d --name mleko-db -p 5432:5432 \
  -e POSTGRES_USER=mleko -e POSTGRES_PASSWORD=mleko -e POSTGRES_DB=mleko \
  postgis/postgis:16-3.5-alpine
# or on Debian/Ubuntu: apt install postgresql-16 postgresql-16-postgis-3
```

Then:

```sh
cp .env.example .env    # defaults work with the container above
npm install
npm run seed            # 10 members, 100 Warsaw places (see Fixtures)
npm run dev             # http://localhost:8080
```

With `DEV_LOGIN=true` (the default in `.env.example`, never honoured in production) you can sign in without Google:

```sh
curl -s -X POST localhost:8080/auth/dev -H 'content-type: application/json' -d '{"email":"kuba@example.com"}'
# → { "token": "...", "has_profile": true, "user": { ... } }
curl -s 'localhost:8080/places?sort=best' -H "authorization: Bearer <token>"
```

For the web app and the admin dashboard, run [dobre-mleko-web](https://github.com/mwalczak/dobre-mleko-web) against this API (`npm run dev` there
proxies to `localhost:8080`); with `DEV_LOGIN` they offer an e-mail sign-in (`marta@example.com` is the seeded admin).

### Fixtures

`npm run seed` fills an empty database with deterministic development data (the same on every run):

- **10 members:** `marta@example.com` (admin), `kuba@`, `ola@`, `tomek@`, `ewa@`, `adam@`, `piotr@`, `hania@`,
  `zosia@` and `filip@example.com`, with display names, badges and favourite categories (onboarding done).
  Everyone in `ADMIN_EMAILS` is added as an admin too, so your own Google account works.
- **100 places** around central Warsaw across all categories, with addresses, descriptions, tags, prices, opening
  hours and statuses (a few temporarily closed or closed).
- **About 440 ratings**, each with one or two generated photos (stored in `PHOTO_DIR` with thumbnails), plus gold
  stars over the last five months (never more than the monthly limit), comments and saved places.

`npm run seed -- --reset` first deletes all users and content (and their photo files), then seeds again; settings
are kept. The script refuses to run when `NODE_ENV=production`, or when the database already has places and
`--reset` is not given.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with reload, reading `.env` |
| `npm run seed [-- --reset]` | Development fixtures |
| `npm run migrate` | Apply migrations (the server also does this at startup) |
| `npm test` | Tests against a real Postgres (see below) |
| `npm run typecheck` · `npm run format` · `npm run format:check` | TypeScript and Prettier |
| `npm run openapi -- openapi.json` | Write the OpenAPI document, as published to the docs |
| `npm run build` · `npm start` | Compile to `dist/` and run it |

### Tests

Tests use a real Postgres with PostGIS; each test file recreates the schema in the test database:

```sh
createdb mleko_test     # or: docker exec mleko-db createdb -U mleko mleko_test
npm test                # TEST_DATABASE_URL defaults to postgres://mleko:mleko@localhost:5432/mleko_test
```

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | – | Postgres connection string |
| `JWT_SECRET` | – | At least 32 characters; signs session tokens and photo URLs |
| `ADMIN_EMAILS` | – | Comma-separated admins. Always whitelisted as admins (re-applied at every start) and cannot be removed or demoted in the dashboard, so nobody can lock everyone out |
| `GOOGLE_CLIENT_IDS` | – | OAuth client IDs of the mobile apps whose Google ID tokens are accepted |
| `APPLE_CLIENT_IDS` | `APNS_APP_IDS` | iOS bundle ids whose Sign in with Apple identity tokens are accepted |
| `GOOGLE_WEB_CLIENT_ID` | – | OAuth client ID of type "Web application" for the web app's and admin dashboard's sign-in button (authorised JavaScript origin: `https://<WEB_HOST>`, the web app's domain) |
| `PHOTO_DIR` | `./data/photos` | Where photo files are stored (a volume in production) |
| `TIME_ZONE` | `Europe/Warsaw` | Month boundaries for gold stars, weeks in stats, "open now" |
| `CORS_ORIGINS` | none | Only needed for a browser client on another origin |
| `APNS_KEY` · `APNS_KEY_ID` · `APNS_TEAM_ID` | – | Push notifications: the APNs auth key (.p8 contents; `\n` escapes accepted), its key id and the Apple team id. Without them nothing is sent |
| `APNS_APP_IDS` | any | Bundle ids iOS devices may register with (the APNs topics), e.g. `pl.dobremleko.app,pl.dobremleko.app.dev` |
| `FCM_SERVICE_ACCOUNT` | – | Android push: the Firebase service account's JSON key file contents. Without it Android devices are registered but not sent to |
| `PMO_API_URL` · `PMO_API_KEY` · `PMO_PROJECT` | – · – · `DM` | [PMO](https://github.com/mwalczak/pmo), the issue tracker behind `/reports`: its URL, this app's key (`pmo_a_…`) and the project. Without them `/reports` answers 503 |
| `DEV_LOGIN` | `false` | Enables `POST /auth/dev` (ignored when `NODE_ENV=production`) |
| `PORT` · `NODE_ENV` | `8080` · `development` | |

Runtime settings live in the database and are edited in the dashboard (defaults and ranges in `src/settings.ts`):

| Setting | Default | |
|---|---|---|
| `starsPerMonth` | `3` | Gold stars per person per calendar month |
| `sessionTtlDays` | `30` | How long a sign-in lasts (applies to new sign-ins) |
| `maxPhotoBytes` | 8 MB | Largest upload (100 KB – 25 MB) |
| `maxPhotosPerRating` | `6` | Photos per rating; every rating has at least one |
| `starRankBonus` | `0.15` | Added to `rank_score` per gold star |

## API

The [API docs](https://mwalczak.github.io/dobre-mleko-be/) are generated from the route schemas in `src/`, and
responses are checked against the same schemas at runtime.

**Conventions:** JSON in `snake_case`, dates in ISO 8601 (UTC), ids are UUID strings. Everything except `/meta`,
`/auth/*` and the signed `/files/*` URLs needs `Authorization: Bearer <token>`. Lists take `limit` (default 30)
and `cursor` and return `{ items, next_cursor, total }`. Errors are `{"error": "<code>", "message": "..."}`:

| Code | HTTP | When |
|---|---|---|
| `not_authenticated` | 401 | No or expired session: sign in again |
| `not_authorized` | 403 | Not on the whitelist, suspended, or not allowed to do this |
| `not_found` | 404 | No such resource |
| `invalid_input` | 422 | Validation: scores, lengths, missing photo, bad cursor, … |
| `no_gold_stars_left` · `gold_star_already_awarded` · `gold_star_revoke_window_passed` | 409 | Gold star rules |
| `rating_needs_photo` · `too_many_photos` · `place_exists` | 409 | Other conflicts (`place_exists` carries `place_id`) |
| `unsupported_type` · `file_too_large` | 415 · 413 | Uploads |
| `email_not_verified` · `invalid_google_token` | 403 · 401 | Sign-in |
| `reports_unavailable` | 503 | The issue tracker (PMO) is not configured or cannot be reached |

| Area | Endpoints |
|---|---|
| Sign-in | `POST /auth/google {id_token}`, `POST /auth/apple {id_token, name?}` → `{token, expires_at, has_profile, user}`; `POST /auth/dev` (development) |
| Me | `GET /me`, `POST /me/profile` (onboarding), `PATCH\|DELETE /me`, `PUT\|DELETE /me/avatar`, `GET /me/gold-stars`, `GET /me/saved`, `GET /me/ratings` |
| Places | `GET /places` (search), `POST /places`, `GET\|PATCH\|DELETE /places/{id}`, `PUT\|DELETE /places/{id}/saved`, `GET /tags` (tag suggestions), `POST /maps-links/resolve` (read a Google Maps link) |
| Ratings | `PUT\|DELETE /places/{id}/rating` (optional `visited_on`), `POST\|DELETE /places/{id}/gold-star` |
| Wishlist | `GET\|POST /me/wishlist`, `PATCH\|DELETE /me/wishlist/{id}`, `GET /wishlist/{id}`, `GET /members/{id}/wishlist`, `GET /wishlist?bbox=` (map layer) |
| Comments | `GET\|POST /places/{id}/comments`, `PATCH\|DELETE /comments/{id}` |
| Photos | `POST /photos` (upload), `DELETE /photos/{id}`, `GET /files/{hash}[/thumb]?exp&sig` (signed) |
| Members | `GET /members` (everyone, with counts, last activity and taste match) |
| Stats | `GET /stats/network`, `GET /stats/me` |
| Meta | `GET /meta`: categories (`category_details`), rating criteria, limits, sign-in options |
| Admin | `GET\|POST /admin/allowed`, `PATCH\|DELETE /admin/allowed/{email}`, `GET /admin/settings`, `PUT\|DELETE /admin/settings/{key}`, `GET\|POST /admin/categories`, `PATCH\|DELETE /admin/categories/{id}`, `PUT /admin/categories/order`, `GET\|POST /admin/icons`, `PATCH\|DELETE /admin/icons/{id}` |

### Sign-in and profiles

The app signs in with Google and sends the ID token to `POST /auth/google`. The server checks the token (audience
`GOOGLE_CLIENT_IDS` + `GOOGLE_WEB_CLIENT_ID`), that the e-mail is verified and whitelisted, creates the account on
first sign-in and returns a session token (HS256 JWT, valid `sessionTtlDays`). On iOS, Sign in with Apple works
the same through `POST /auth/apple` (audience `APPLE_CLIENT_IDS`, the bundle ids): the same e-mail is the same
account, later tokens without an e-mail find it by the Apple id, and a Hide My Email address that is not on the
list gets 403 `private_email`. While `has_profile` is false the app
shows onboarding and finishes it with `POST /me/profile`: display name, badge (up to 16 characters; empty clears
it) and up to 3 favourite categories. Profiles shown to others never include the e-mail.

`DELETE /me` deletes the account (App Store requirement): the personal data goes (e-mail, name, badge, avatar,
Google/Apple ids, favourites, saved places, the wishlist, devices, the access-list entry), places, ratings, photos and comments
stay, shown as by "Były członek" (status `deleted`).

### Wishlist

Places someone wants to visit, seen by everyone in the network: on profiles (`GET /members/{id}/wishlist`) and
as a map layer (`GET /wishlist?bbox=`, not yet visited only unless `visited=true`). Not regular places: a name, a
point, an optional address, description (up to 1000 characters) and http(s) link — no category, ratings or
photos. `PATCH /me/wishlist/{id}` with `visited_on` (a date, not in the future) marks it visited; it stays on the
list, and once added as a regular place `place_id` links it. Ratings take the same optional `visited_on` (when I
was there; `my_visited_on` in the place, `visited_on` in `GET /me/ratings`, never shown to others).

Every request re-checks the whitelist, the role and the account status, so removing someone, changing their role
or suspending them applies to existing sessions immediately. Their content stays.

### People and taste match

`GET /members` lists everyone except deleted accounts, most recently active first (latest place, rating, comment
or wishlist item), with places added, ratings, wishlist items still to visit and the taste match with me. The
network is small, so the list is not paged.

Taste match is `0.5 + (r / 2) · n / (n + 5)`: `r` is the Pearson correlation of overall ratings on the `n` places
both rated. With few shared places it stays near 50% (3 identical ratings give 69%, 20 give 90%), so a couple of
lucky agreements do not top the list. `shared` is `n`; below 3 shared places `match` is null. `GET /stats/me`
returns the top 3 the same way.

### Categories

Categories are data, managed by admins in the dashboard (`/admin/categories`), and every client reads them from
`GET /meta`: `category_details` lists each one with its id, Polish `label`, `color` (`#RRGGBB`), `shape` (one of
`circle half triangle triangle_down ring square quarter house`; the geometry is in the OpenAPI `Category` schema),
`icon` (the pictogram: `{ id, path }` — SVG path data on a 24×24 grid, filled even-odd in the category's colour;
null — draw the shape), `position` and `active`. Draw a category's mark from these instead of building categories
into the app. Places
refer to a category by id, which never changes; `categories` in `/meta` (active ids, in order) stays for older
clients.

A retired category (`active: false`) keeps its places, which still need drawing, but is not offered for new ones
(422 when a place is added to it or moved into it). A category can be deleted only while no place uses it; it then
also leaves people's favourite categories. One category always stays active. Migration 007 created the first
eleven: `food coffee bar club kids culture nature sport shopping hotel other`.

### Icons

Pictograms are data too: an icon library (`/admin/icons`: id, Polish name, SVG path) that admins add to, change and
delete from (only icons no category uses; 409 `icon_in_use`), and categories point at an icon. Every app draws the
same path, so a new pictogram needs no app release. A path is the `d` attribute of a `<path>` in a
`viewBox="0 0 24 24"` SVG: commands `M L H V C S Q T A Z` and numbers only (no markup), absolute points within the
grid, at most 8000 characters. Migration 008 seeded the pictograms the iOS app drew (plate, cup, cocktail, notes,
teddy, palette, pine, ball, bag, bed, beer mug, museum, pool, eye, shapes) and added `brewery` (Pivovar), `museum`,
`pool` (Basen) and `curiosity` (Osobliwość) before `other`.

### Push notifications

The apps register their device token with `PUT /me/devices` (token, platform, APNs environment — `sandbox` for
development-signed builds, `production` for TestFlight and the App Store — and the bundle id, the APNs topic) and
remove it with `DELETE /me/devices/{token}` on sign-out. People choose what they get in `PATCH /me`
(`notifications`): new places — `all`, `favorites` (only in their favourite categories; the default) or `none` —
comments (on places they added, commented on or saved), gold stars and joins (`gold_stars`, `joins`; all three
on by default).

- **New place:** to people with its category among their favourites, or who want all new places; not its author.
- **New comment:** to the place's author, others who commented on it and those who saved it; not the commenter.
- **Gold star:** to the place's author, unless they gave it themselves; opens the place.
- **Someone joined:** when a person finishes onboarding (`POST /me/profile`, the first time), to whoever put
  their e-mail on the list (`allowed_emails.added_by`, in practice an admin) — the stand-in for "my invite was
  used" while invites are not in the MVP.
- **Admins** (`/admin/push`): who gets notifications on which devices, a message to everyone, to chosen people
  or by favourite category (optionally opening a place), and the log of everything sent (`/admin/push/log`).

Event notifications are sent after the response. iOS devices get them through APNs — the payload is
`{ aps: { alert: { title, body }, sound }, place_id }` — and Android devices through Firebase Cloud Messaging
(HTTP v1): a notification message `{ notification: { title, body }, data: { place_id } }`. Tokens rejected for
good (APNs `Unregistered`, `BadDeviceToken`; FCM `UNREGISTERED`, `SENDER_ID_MISMATCH`) are forgotten.

- **Apple setup:** enable *Push Notifications* on the app ids, create an APNs key (Keys → Apple Push Notifications
  service) and set `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID`.
- **Firebase setup:** in a Firebase project add the Android apps (`app.dobremleko`, `.dev`, `.staging`) — their
  `google-services.json` goes to the Android app — and under Project settings → Service accounts generate a private
  key; its JSON file is `FCM_SERVICE_ACCOUNT`. The account needs the *Firebase Cloud Messaging API Admin* role
  (the default Firebase Admin SDK account has it).

### Adding a place from a Google Maps link

`POST /maps-links/resolve {text}` reads a pasted Google Maps link: full links, and the app's `maps.app.goo.gl` share
links, which the API follows itself (hop by hop, Google hosts only, 5 s timeout; the EU consent detour is skipped).
It returns the place's `name` and `location` (`precise: false` when the link only has a map view), the `url` to keep
(the short link as pasted, else the full one without tracking parameters) and places already within 150 m, likeliest
duplicates first. The apps then fill the address and category from a map search and save the link as the place's
`google_maps_url`, so it opens in Google Maps. Nothing else is taken from Google: the link carries no address,
hours or category, and reading Google's pages would be against their terms.

### Places and search

A place has a name, category (see below), location, optional
address, description (up to 500 characters), price level 1–4, tags, opening hours and a status (`active`,
`temporarily_closed`, `closed`). `POST /places` adds it **together with the author's rating and photos** (and
optionally a gold star) in one transaction. The author or an admin edits or deletes it.

`GET /places` combines:

- `q`: name, description, address and tags, ignoring case and Polish accents ("zolw" finds "Żółw");
- `categories`, `min_rating`, `gold_only`, `tags`, `prices`, `added_by`, `unrated_only` (not rated by me),
  `saved_only`, `include_closed` (closed places are hidden by default);
- `lat` + `lng` (adds `distance_m`), `radius_m`, and `bbox=minLng,minLat,maxLng,maxLat` for the map (`limit` up
  to 500);
- `sort`: `best` (`rank_score`), `gold_stars` (all-time), `nearest`, `newest`, `most_commented`; ties are broken
  stably.

`GET /places/{id}` adds photos, criteria averages and the strongest criterion, the rating distribution, my scores,
who gave gold stars, all comments (oldest first), my gold star and `gold_stars_left`.

### Ratings, photos and gold stars

A rating has `vibe` (klimat) and `offer` (oferta), required, and `service` (obsługa) and `value` (wartość), which
may be null ("nie dotyczy"), each 1–5; `overall` is the average of the given ones. One rating per person per place;
`PUT` again to change it.

**Every rating has at least one photo.** The app uploads photos first with `POST /photos` (multipart: the file
plus an optional `blurhash` field), then passes their ids as `photo_ids` when adding a place or rating one. Photos
are added to the rating's existing ones, up to `maxPhotosPerRating`. The last photo of a rating cannot be deleted,
deleting a rating deletes its photos, and uploads never attached are removed after 24 hours.

Gold stars ("musisz tam iść") don't change the displayed average: `starsPerMonth` per person per calendar month
(`TIME_ZONE`), once per place per month, and they can be taken back during that month. They count towards ranking:

```
rank_score = v/(v+3)·R + 3/(v+3)·C + starRankBonus·gold_star_count
```

where `R` is the place's average, `v` its number of ratings and `C` the average of all ratings, so a single 5★
doesn't beat a place with many high ratings.

### Stats

`/stats/network`: members, places, ratings, average rating, gold stars this month, the star of the month, the top
10, places per category and ratings per week for the last 12 weeks. `/stats/me`: my places and ratings, average
and distribution of my ratings, my categories, my places that got gold stars, and **taste matches**: the Pearson
correlation of overall ratings on places both rated (at least 3), mapped to 0–1 as `(r + 1) / 2` (1 when identical
without variation, else 0.5).

## How it works

### Photos and avatars

Files are stored in `PHOTO_DIR` under their SHA-256 (`<dir>/6b/6b7f…`), each with a 400 px JPEG thumbnail
(`….thumb`, made with sharp). The database keeps only the hash, type, size, dimensions and blurhash; the type is
detected from the file's bytes, not from what the client claims. Identical files share one copy, deleted when no
photo or avatar uses it any more (under a per-hash advisory lock).

Photos are private. Responses carry signed URLs (`/files/<hash>?exp=…&sig=…`, HMAC with a key derived from
`JWT_SECRET`) that expire after 12–24 hours and stay identical within a 12-hour window, so clients can cache images.

### Database

Migrations in `migrations/` run in order at startup (an advisory lock makes concurrent starts safe):

| Migration | |
|---|---|
| `001_init.sql` | Users, places, photos, ratings (`overall` computed), gold stars, comments, saved places |
| `002_whitelist_settings.sql` | Whitelist (`allowed_emails`, roles) and runtime settings |
| `003_postgis.sql` | PostGIS: `places.geom` follows `lat`/`lng`; GiST indexes on `geom` (map) and `geom::geography` (distances) |
| `004_contract.sql` | `unaccent` + `pg_trgm`: accent-free `search_text` with a trigram index; place status; profile fields; photos belonging to ratings; `profile_json()` |

Distances use `ST_DWithin`, `ST_Distance` and the `<->` nearest-neighbour operator on `geom::geography`; the map
uses `geom && ST_MakeEnvelope(...)`. Tests check that these and the text search use their indexes.

### Web clients

This repository is the API only. The web app and the admin dashboard live in [dobre-mleko-web](https://github.com/mwalczak/dobre-mleko-web): they are served
from their own domain, and nginx there proxies `/api/*` and `/files/*` to this API's in-cluster service, so the
browser sees one origin (no CORS) and signed photo URLs work unchanged. The dashboard uses the `/admin/*` endpoints
and `GET /stats/network`; sign-in uses `GET /meta` (`google_web_client_id`, `dev_login`).

### Issue reports

`/reports` is a thin layer over [PMO](https://github.com/mwalczak/pmo), the issue tracker, built the way PMO's
[`pmo-thin-client` skill](https://github.com/mwalczak/pmo/blob/main/.claude/skills/pmo-thin-client/SKILL.md)
describes. This API calls PMO server-to-server with the `dobre-mleko.app` key (`PMO_API_KEY`, never sent to
clients):

- `GET /reports/options`: the issue types and platforms to offer, with their Polish labels, as configured on the
  `DM` project in PMO (cached for 5 minutes). Nothing about the form is hardcoded in the apps.
- `POST /reports` (multipart): files the report with the signed-in member's e-mail and name, then uploads up to 3
  screenshots or recordings (50 MB each; temp files on disk, streamed to PMO). PMO creates an account for a new
  reporter, e-mails them a personal key, and e-mails them when their reports' status changes.
- `GET /reports`: open or closed reports, with typo-tolerant search. Abuse reports are private in PMO and never
  listed.

The web app's `/report` page uses all three.

### Project layout

```
src/
  server.ts          startup: config, migrations, admins, hourly cleanup of unattached uploads
  app.ts             Fastify app, error format, OpenAPI
  routes/            one file per area (auth, me, places, ratings, comments, photos, stats, meta, admin, reports)
  pmo.ts             client for PMO, the issue tracker behind /reports
  places-query.ts    the shared search and ranking query
  rating-logic.ts    photos-per-rating rule and gold star quota
  photo-store.ts     files on the volume; uploads.ts reads multipart images; file-urls.ts signs URLs
  schemas.ts         response schemas (also the OpenAPI components)
  settings.ts        runtime settings; config.ts environment variables
  seed.ts            development fixtures; openapi.ts writes the OpenAPI document
migrations/          SQL migrations
test/                API tests (vitest, real Postgres)
```

## Contract notes

Where this API differs from the iOS handoff, pending decisions with Adam:

- **Ratings** use four criteria (atmosphere, offer, service, value) instead of a single 1–5 value; `my_rating` and
  `rating_distribution` use the overall average (rounded to whole stars for the distribution).
- **Gold stars** are once per place per month and can be taken back during their month (the contract: once per
  place ever, 24-hour revoke window). The error codes are the contract's.
- **Photos:** at most `maxPhotosPerRating` per rating instead of 6 per place, since every rating has a photo.
- **Sign-in** is Google and Apple (no magic link); `not_authenticated` (401) is an extra error code.
- **`lat`/`lng`** are optional in search.
- **Not built yet:** reports, duplicate check, member list and profiles, suspension controls, data export, realtime, push.

## Deploy

CI (`ci.yml`) runs typecheck, tests (with a PostGIS service), build and an OpenAPI check on every push and pull
request. When it passes on `main`, `deploy.yml` builds the image, pushes it to GHCR and applies `k8s.yaml` on the
k3s server over SSH (same setup as `ip`): the `dobre-mleko` namespace with a Postgres + PostGIS StatefulSet (5 Gi),
a 10 Gi photo volume, the API and a Traefik ingress with a cert-manager certificate. The API uses the `Recreate`
strategy because the photo volume is mounted by one pod at a time, so a deploy has a few seconds of downtime.

Repository secrets: `VPS_HOST`, `VPS_SSH_KEY`, `POSTGRES_PASSWORD` (letters and digits only, it goes into a URL:
`openssl rand -hex 24`), `JWT_SECRET` (`openssl rand -base64 48`), `ADMIN_EMAILS`.
Repository variables: `API_HOST` (the API's domain), `GOOGLE_CLIENT_IDS`, `GOOGLE_WEB_CLIENT_ID`, optionally
`APPLE_CLIENT_IDS` (defaults to `APNS_APP_IDS`).
Push notifications: secret `APNS_KEY` (the .p8 file's contents), variables `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_APP_IDS`; Android — secret `FCM_SERVICE_ACCOUNT` (the service account's JSON key file).
Issue reports: secrets `PMO_API_URL` and `PMO_API_KEY` (the `dobre-mleko.app` key in PMO).

The whitelist and settings are managed at `https://<WEB_HOST>/admin/` (see dobre-mleko-web). Changing `ADMIN_EMAILS` needs the secret
edited and the "Build and deploy" workflow re-run. After the first run, make the GHCR package public or add an
image pull secret. Back up both the Postgres volume and the photo volume: the database refers to files by hash.

### API docs

`docs.yml` regenerates the docs on every push to `main` and publishes them to GitHub Pages
(Settings → Pages → Source: **GitHub Actions**).
