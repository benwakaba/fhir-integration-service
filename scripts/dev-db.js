// Local Postgres without Docker or a system install: runs the embedded-postgres
// binaries (a devDependency) with the port and credentials from DATABASE_URL and
// keeps data under .pgdata/. Leave it running in its own terminal; Ctrl+C stops it.
//
//   npm run db:start

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { config } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startEmbeddedPostgres({ databaseUrl, dataDir, persistent = true }) {
  const url = new URL(databaseUrl);
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: decodeURIComponent(url.username) || 'postgres',
    password: decodeURIComponent(url.password) || 'postgres',
    port: Number(url.port || 5432),
    persistent,
    onLog: () => {},
  });
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
  // embedded-postgres rejects with no error object when the server fails to start,
  // which in practice almost always means the port is taken.
  await pg.start().catch((err) => {
    throw err ?? new Error(`Postgres failed to start on port ${url.port || 5432}. Is another server listening there?`);
  });
  const database = url.pathname.slice(1);
  if (database && database !== 'postgres') {
    await pg.createDatabase(database).catch((err) => {
      if (err.code !== '42P04') throw err; // already exists
    });
  }
  return pg;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!config.databaseUrl) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }
  const pg = await startEmbeddedPostgres({ databaseUrl: config.databaseUrl, dataDir: path.join(ROOT, '.pgdata') });
  const shown = new URL(config.databaseUrl);
  shown.password = '***';
  console.log(`Postgres is running at ${shown}. Ctrl+C to stop.`);
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
