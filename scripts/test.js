// Test runner. Tests run against a real Postgres: TEST_DATABASE_URL if set (CI,
// docker compose), otherwise a throwaway embedded Postgres on a free port with its
// data in a temp directory, removed afterwards.
//
//   npm test
//   npm test -- test/mpi.test.js

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = net.createServer().listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

let embedded;
let dataDir;
let databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  const { startEmbeddedPostgres } = await import('./dev-db.js');
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'fhir-integration-test-'));
  databaseUrl = `postgresql://postgres:postgres@localhost:${await freePort()}/fhir_integration_test`;
  embedded = await startEmbeddedPostgres({ databaseUrl, dataDir, persistent: false });
}

const files = process.argv.slice(2);
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=60000', ...(files.length ? files : ['test/*.test.js'])], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl, LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent', PUBLIC_BASE_URL: 'http://fhir.test', API_KEY: '' },
});
const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
if (embedded) await embedded.stop();
if (dataDir) rmSync(dataDir, { recursive: true, force: true });
process.exit(code);
