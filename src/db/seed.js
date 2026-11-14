// Idempotent seed: the configured sources, and terminology fragments (the concept
// catalog's LOINC codes and the ICD-10-CM codes under its category roots) so that
// lookups and displays work before full LOINC / ICD-10-CM releases are loaded.
// A system already loaded in full is never downgraded to the fragment.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { CONCEPTS } from '../terminology/concepts.js';
import { ICD10CM, LOINC } from '../terminology/systems.js';
import pool from './pool.js';

export const SOURCES = [
  { id: 'smart', name: 'SMART Health IT R4 sandbox', baseUrl: config.sourceBaseUrls.smart, kind: 'pull', priority: 20 },
  { id: 'hapi', name: 'HAPI FHIR public R4 server', baseUrl: config.sourceBaseUrls.hapi, kind: 'pull', priority: 30 },
  { id: 'clinic-b', name: 'Clinic B EHR (simulated push source)', baseUrl: null, kind: 'push', priority: 10 },
];

export async function seed(db = pool) {
  for (const s of SOURCES) {
    await db.query(
      `INSERT INTO sources (id, name, base_url, kind, priority) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, base_url = EXCLUDED.base_url,
         kind = EXCLUDED.kind, priority = EXCLUDED.priority`,
      [s.id, s.name, s.baseUrl, s.kind, s.priority],
    );
  }

  const loincCodes = new Map();
  for (const concept of CONCEPTS) {
    for (const m of [...concept.members, ...(concept.excluded ?? [])]) {
      if (m.system === LOINC) loincCodes.set(m.code, { code: m.code, display: m.display, status: m.status ?? 'active' });
    }
  }
  const icd = JSON.parse(readFileSync(new URL('../terminology/seed/icd10cm-fragment.json', import.meta.url), 'utf-8'));

  await seedFragment(db, LOINC, 'LOINC', [...loincCodes.values()]);
  await seedFragment(db, ICD10CM, 'ICD-10-CM', icd.codes.map((c) => ({ ...c, status: 'active' })));
}

async function seedFragment(db, url, name, codes) {
  const { rows } = await db.query('SELECT content FROM code_systems WHERE url = $1', [url]);
  if (rows[0]?.content === 'complete') return;
  await db.query(
    `INSERT INTO code_systems (url, name, content, source, code_count, loaded_at) VALUES ($1, $2, 'fragment', 'seed', $3, now())
     ON CONFLICT (url) DO UPDATE SET content = 'fragment', source = 'seed', code_count = EXCLUDED.code_count, loaded_at = now()`,
    [url, name, codes.length],
  );
  await db.query(
    `INSERT INTO codes (system, code, display, status)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[])
     ON CONFLICT (system, code) DO UPDATE SET display = EXCLUDED.display, status = EXCLUDED.status`,
    [url, codes.map((c) => c.code), codes.map((c) => c.display), codes.map((c) => c.status)],
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => {
      console.log('Seed applied.');
      return pool.end();
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
