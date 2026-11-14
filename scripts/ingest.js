// Pull data from a source FHIR server.
//
//   npm run ingest -- --source smart --patients 25
//   npm run ingest -- --source smart --patients 25 --has-code http://loinc.org|4548-4
//   npm run ingest -- --source hapi --patients 10 --types Observation,Condition,Encounter
//   npm run ingest -- --source smart --sync Observation [--since 2024-01-01] [--max-pages 10]

import { parseArgs } from 'node:util';
import pool from '../src/db/pool.js';
import { DEFAULT_TYPES, ingestPatients, syncType } from '../src/ingest/runner.js';
import { getSource } from '../src/ingest/sources.js';

const { values } = parseArgs({
  options: {
    source: { type: 'string', default: 'smart' },
    patients: { type: 'string', default: '20' },
    types: { type: 'string', default: DEFAULT_TYPES.join(',') },
    'has-code': { type: 'string' },
    sync: { type: 'string' },
    since: { type: 'string' },
    'max-pages': { type: 'string', default: '20' },
  },
});

try {
  const source = await getSource(pool, values.source);
  const started = Date.now();
  const run = values.sync
    ? await syncType(source, { type: values.sync, since: values.since, maxPages: Number(values['max-pages']) })
    : await ingestPatients(source, {
        patients: Number(values.patients),
        types: values.types.split(',').map((t) => t.trim()).filter(Boolean),
        // _has narrows the Patient search to people with a matching Observation.
        query: values['has-code'] ? { '_has:Observation:patient:code': values['has-code'] } : {},
      });
  console.log(
    `Run ${run.id} ${run.status} in ${((Date.now() - started) / 1000).toFixed(1)}s: ${run.pages} pages, ` +
      `${run.created} created, ${run.updated} updated, ${run.unchanged} unchanged, ${run.with_errors} with errors`,
  );
} catch (err) {
  console.error(`Ingest failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
