import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { fillAddressTowns } from './address-towns.js';
import { buildApp } from './app.js';
import { ensureAdmins } from './auth.js';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { cleanupUnattached, PhotoStore } from './photo-store.js';

const config = loadConfig();

// Fail at startup, not on the first upload, if the photo volume is missing or read-only.
await mkdir(config.PHOTO_DIR, { recursive: true });
await access(config.PHOTO_DIR, constants.W_OK);
const sql = createDb(config.DATABASE_URL);

const applied = await migrate(sql);
await ensureAdmins(sql, config.ADMIN_EMAILS);
const app = await buildApp({ config, sql, logger: true });
if (applied.length) app.log.info({ applied }, 'migrations applied');
if (!config.ADMIN_EMAILS.length) app.log.warn('ADMIN_EMAILS is empty: nobody can open the admin dashboard');

// Uploads that were never attached to a rating are removed after a day.
const photos = new PhotoStore(config.PHOTO_DIR);
const cleanup = setInterval(
  () =>
    cleanupUnattached(sql, photos, new Date(Date.now() - 24 * 3600 * 1000)).then(
      (n) => n && app.log.info({ removed: n }, 'unattached photos removed'),
      (err) => app.log.error(err, 'photo cleanup failed'),
    ),
  3600 * 1000,
);
cleanup.unref();

// Towns for addresses the mobile apps saved as street and number only, a batch an hour (see address-towns.ts);
// in production only, so local development never calls OpenStreetMap.
const fillTowns = () =>
  fillAddressTowns(sql, { limit: 100 }).then(
    (n) => n && app.log.info({ changed: n }, 'towns added to addresses'),
    (err) => app.log.error(err, 'filling address towns failed'),
  );
const towns = config.NODE_ENV === 'production' ? setInterval(fillTowns, 3600 * 1000) : undefined;
towns?.unref();

const shutdown = async () => {
  clearInterval(cleanup);
  clearInterval(towns);
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: config.PORT });
if (config.NODE_ENV === 'production') void fillTowns();
