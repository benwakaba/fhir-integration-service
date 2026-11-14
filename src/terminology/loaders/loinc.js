// Loads a LOINC release into `codes` from the LOINC download
// (https://loinc.org/downloads/, free with an account):
//   LoincTable/Loinc.csv                      terms (required)
//   LoincTable/MapTo.csv                      replacements for deprecated/discouraged terms
//   AccessoryFiles/AnswerFile/AnswerList.csv  answer codes (LA) and answer lists (LL)
//   AccessoryFiles/PartFile/Part.csv          parts (LP)
// Which of these were loaded is recorded (code_systems.includes), so validation
// only calls a code non-existent for a kind of code the load actually covered.
// Columns are found by header name, so column order changes between releases do
// not matter. The load is one transaction: the full release replaces whatever was
// there (usually the seed fragment), or nothing changes.

import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import { withTransaction } from '../../db/pool.js';
import { LOINC } from '../systems.js';

const STATUS = { ACTIVE: 'active', DEPRECATED: 'deprecated', DISCOURAGED: 'discouraged', TRIAL: 'trial' };

export async function loadLoinc({ file, mapToFile, answersFile, partsFile, version }) {
  const mapTo = mapToFile ? await readMapTo(mapToFile) : new Map();
  const rows = [];
  for await (const r of readCsv(file)) {
    if (!r.LOINC_NUM) throw new Error(`${file} has no LOINC_NUM column; expected LoincTable/Loinc.csv`);
    rows.push({
      code: r.LOINC_NUM,
      display: r.LONG_COMMON_NAME || r.SHORTNAME || r.COMPONENT,
      status: STATUS[r.STATUS] ?? 'active',
      properties: compact({
        component: r.COMPONENT,
        property: r.PROPERTY,
        timeAspect: r.TIME_ASPCT,
        system: r.SYSTEM,
        scale: r.SCALE_TYP,
        method: r.METHOD_TYP,
        class: r.CLASS,
        shortName: r.SHORTNAME,
        exampleUcumUnits: r.EXAMPLE_UCUM_UNITS,
        mapTo: mapTo.get(r.LOINC_NUM),
      }),
    });
  }
  const includes = ['terms'];
  const counts = { terms: rows.length };
  if (answersFile) {
    const seen = new Set();
    for await (const r of readCsv(answersFile)) {
      // One row per answer per list: the same answer (LA) appears in many lists (LL).
      if (r.AnswerListId && !seen.has(r.AnswerListId)) {
        seen.add(r.AnswerListId);
        rows.push({ code: r.AnswerListId, display: r.AnswerListName, status: 'active', properties: { kind: 'answer-list' } });
      }
      if (r.AnswerStringId && !seen.has(r.AnswerStringId)) {
        seen.add(r.AnswerStringId);
        rows.push({ code: r.AnswerStringId, display: r.DisplayText, status: 'active', properties: { kind: 'answer' } });
      }
    }
    includes.push('answers', 'answer-lists');
    counts.answers = seen.size;
  }
  if (partsFile) {
    let parts = 0;
    for await (const r of readCsv(partsFile)) {
      rows.push({ code: r.PartNumber, display: r.PartDisplayName || r.PartName, status: STATUS[r.Status] ?? 'active', properties: { kind: 'part', partType: r.PartTypeName } });
      parts++;
    }
    includes.push('parts');
    counts.parts = parts;
  }
  const release = version ?? /Loinc_?(\d+\.\d+)/i.exec(file)?.[1] ?? null;
  await replaceSystem(LOINC, 'LOINC', release, file, rows, includes);
  return { system: LOINC, version: release, codes: rows.length, counts, includes };
}

function readCsv(file) {
  return createReadStream(file).pipe(parse({ columns: true, bom: true, relax_quotes: true }));
}

async function readMapTo(file) {
  const map = new Map();
  for await (const r of readCsv(file)) {
    if (!r.LOINC || !r.MAP_TO) continue;
    map.set(r.LOINC, [...(map.get(r.LOINC) ?? []), r.MAP_TO]);
  }
  return map;
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));
}

/** Atomically replace a code system's content with a complete release. */
export async function replaceSystem(url, name, version, source, rows, includes = []) {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO code_systems (url, name, version, content, includes, source, code_count, loaded_at)
       VALUES ($1, $2, $3, 'complete', $4, $5, $6, now())
       ON CONFLICT (url) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, content = 'complete',
         includes = EXCLUDED.includes, source = EXCLUDED.source, code_count = EXCLUDED.code_count, loaded_at = now()`,
      [url, name, version, includes, source, rows.length],
    );
    await client.query('DELETE FROM codes WHERE system = $1', [url]);
    for (let i = 0; i < rows.length; i += 5000) {
      const batch = rows.slice(i, i + 5000);
      await client.query(
        `INSERT INTO codes (system, code, display, status, properties)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::jsonb[])`,
        [url, batch.map((r) => r.code), batch.map((r) => r.display), batch.map((r) => r.status), batch.map((r) => JSON.stringify(r.properties ?? {}))],
      );
    }
  });
}
