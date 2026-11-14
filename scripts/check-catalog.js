// Check the concept catalog against the loaded code system releases. Run it after
// loading a new LOINC or ICD-10-CM release; it exits non-zero when the catalog has
// fallen out of step:
//   - a catalog code is missing from the release, or its status changed there
//     (a member deprecated or discouraged without its replacement in the catalog)
//   - a member's LOINC example unit is not one its concept can convert, so results
//     sent in LOINC's own suggested unit would come back un-normalized
//   - an ICD-10-CM root or exact member is not in the release
// --suggest also lists release codes that share a member's LOINC component, are
// point-in-time quantitative results in a blood/serum/plasma specimen, and are not
// in the catalog: candidates for a human to review, never added automatically.
//
//   npm run terminology:check [-- --suggest]

import { parseArgs } from 'node:util';
import pool from '../src/db/pool.js';
import { CONCEPTS } from '../src/terminology/concepts.js';
import { loadedSystems } from '../src/terminology/service.js';
import { ICD10CM, LOINC } from '../src/terminology/systems.js';
import { quantityUnit } from '../src/terminology/units.js';

const { values } = parseArgs({ options: { suggest: { type: 'boolean', default: false } } });

const problems = [];
const notes = [];
const report = (list, concept, code, message) => list.push(`${concept.padEnd(30)} ${code.padEnd(9)} ${message}`);

async function codesFor(system, codes) {
  const { rows } = await pool.query('SELECT code, status, display, properties FROM codes WHERE system = $1 AND code = ANY($2)', [system, codes]);
  return new Map(rows.map((r) => [r.code, r]));
}

async function checkLoinc(release) {
  const entries = CONCEPTS.flatMap((c) => [
    ...c.members.map((m) => ({ c, m, member: true })),
    ...(c.excluded ?? []).map((m) => ({ c, m, member: false })),
  ]).filter((e) => e.m.system === LOINC);
  const found = await codesFor(LOINC, entries.map((e) => e.m.code));
  const inCatalog = new Map(entries.filter((e) => e.member).map((e) => [e.m.code, e.c.id]));

  for (const { c, m, member } of entries) {
    const row = found.get(m.code);
    if (!row) {
      report(problems, c.id, m.code, `not in LOINC ${release.version}`);
      continue;
    }
    if (row.status !== (m.status ?? 'active')) report(problems, c.id, m.code, `catalog says ${m.status ?? 'active'}, LOINC ${release.version} says ${row.status}`);
    const official = row.display.replace(/^Deprecated /, '');
    if (official !== m.display) report(notes, c.id, m.code, `LOINC name is now "${official}"`);
    if (!member) continue;
    for (const replacement of row.properties.mapTo ?? []) {
      if (inCatalog.get(replacement) !== c.id) report(problems, c.id, m.code, `${row.status}; LOINC's replacement ${replacement} is not a member`);
    }
    const units = (row.properties.exampleUcumUnits ?? '').split(/;\s*/).filter(Boolean);
    for (const unit of units) {
      const { ucum } = quantityUnit({ value: 1, system: 'http://unitsofmeasure.org', code: unit });
      if (!c.units?.[ucum]) report(problems, c.id, m.code, `LOINC's example unit '${unit}' is not convertible to ${c.unit}`);
    }
  }
  return entries.length;
}

async function checkIcd10cm(release) {
  const entries = CONCEPTS.flatMap((c) => [...c.members, ...(c.excluded ?? [])].map((m) => ({ c, m }))).filter((e) => e.m.system === ICD10CM);
  const found = await codesFor(ICD10CM, entries.map((e) => e.m.code));
  for (const { c, m } of entries) {
    const row = found.get(m.code);
    if (!row) report(problems, c.id, m.code, `not in ICD-10-CM ${release.version}`);
    else if (m.match === 'exact' && row.status !== 'active') report(problems, c.id, m.code, `exact member is a ${row.status} code in ${release.version}`);
  }
  return entries.length;
}

async function suggest() {
  const catalog = new Set(CONCEPTS.flatMap((c) => [...c.members, ...(c.excluded ?? [])].map((m) => m.code)));
  for (const concept of CONCEPTS.filter((c) => c.domain === 'observation')) {
    const members = await codesFor(LOINC, concept.members.map((m) => m.code));
    const components = [...new Set([...members.values()].map((r) => r.properties.component).filter(Boolean))];
    if (!components.length) continue;
    const { rows } = await pool.query(
      `SELECT code, status, display FROM codes
       WHERE system = $1 AND properties->>'component' = ANY($2) AND properties->>'scale' = 'Qn'
         AND properties->>'timeAspect' = 'Pt' AND status IN ('active', 'trial')
         AND properties->>'system' ~ '^(Bld|Ser|Plas|Ser/Plas|Ser/Plas/Bld|Bld\\.dot|Bld[A-Z]{1,2}|XXX|\\^Patient)'
       ORDER BY code`,
      [LOINC, components],
    );
    const candidates = rows.filter((r) => !catalog.has(r.code));
    if (!candidates.length) continue;
    console.log(`\n${concept.id}: ${candidates.length} candidate(s)`);
    for (const r of candidates.slice(0, 25)) console.log(`  ${r.code.padEnd(9)} ${r.status.padEnd(6)} ${r.display}`);
    if (candidates.length > 25) console.log(`  ... ${candidates.length - 25} more`);
  }
}

try {
  const systems = await loadedSystems(pool);
  const loinc = systems.get(LOINC);
  const icd = systems.get(ICD10CM);
  if (loinc?.content !== 'complete' && icd?.content !== 'complete') throw new Error('No full release is loaded; run npm run terminology:load first');
  const checked = [];
  if (loinc?.content === 'complete') checked.push(`${await checkLoinc(loinc)} LOINC entries against ${loinc.version}`);
  if (icd?.content === 'complete') checked.push(`${await checkIcd10cm(icd)} ICD-10-CM entries against ${icd.version}`);
  for (const line of problems) console.log(`PROBLEM ${line}`);
  for (const line of notes) console.log(`note    ${line}`);
  console.log(`Checked ${checked.join(' and ')}: ${problems.length} problem(s), ${notes.length} note(s).`);
  if (values.suggest && loinc?.content === 'complete') await suggest();
  if (problems.length) process.exitCode = 1;
} catch (err) {
  console.error(`Check failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
