// Load full code system releases (replacing the seed fragments).
//
//   npm run terminology:load -- --loinc ~/Downloads/Loinc_2.83
//       (the release folder: Loinc.csv, MapTo.csv, answer lists and parts are found in it;
//        or name files with --loinc <Loinc.csv> --loinc-mapto/--loinc-answers/--loinc-parts)
//   npm run terminology:load -- --icd10cm data/terminology/icd10cm_order_2026.txt
//
// Then `npm run revalidate`, so stored resources are re-checked against the releases.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pool from '../src/db/pool.js';
import { loadIcd10cm } from '../src/terminology/loaders/icd10cm.js';
import { loadLoinc } from '../src/terminology/loaders/loinc.js';

const { values } = parseArgs({
  options: {
    loinc: { type: 'string' },
    'loinc-mapto': { type: 'string' },
    'loinc-answers': { type: 'string' },
    'loinc-parts': { type: 'string' },
    'loinc-version': { type: 'string' },
    icd10cm: { type: 'string' },
    'icd10cm-version': { type: 'string' },
  },
});

// A release folder, or Loinc.csv plus explicitly named companion files.
function loincFiles(arg) {
  const pick = (explicit, candidate) => explicit ?? (existsSync(candidate) ? candidate : undefined);
  if (statSync(arg).isDirectory()) {
    const file = path.join(arg, 'LoincTable', 'Loinc.csv');
    if (!existsSync(file)) throw new Error(`${arg} has no LoincTable/Loinc.csv`);
    return {
      file,
      mapToFile: pick(values['loinc-mapto'], path.join(arg, 'LoincTable', 'MapTo.csv')),
      answersFile: pick(values['loinc-answers'], path.join(arg, 'AccessoryFiles', 'AnswerFile', 'AnswerList.csv')),
      partsFile: pick(values['loinc-parts'], path.join(arg, 'AccessoryFiles', 'PartFile', 'Part.csv')),
    };
  }
  return { file: arg, mapToFile: values['loinc-mapto'], answersFile: values['loinc-answers'], partsFile: values['loinc-parts'] };
}

try {
  if (!values.loinc && !values.icd10cm) throw new Error('Nothing to load: pass --loinc <Loinc.csv> and/or --icd10cm <icd10cm_order_YYYY.txt>');
  if (values.loinc) {
    const files = loincFiles(values.loinc);
    const r = await loadLoinc({ ...files, version: values['loinc-version'] ?? /Loinc_?(\d+\.\d+)/i.exec(values.loinc)?.[1] });
    const parts = Object.entries(r.counts).map(([kind, n]) => `${n} ${kind}`).join(', ');
    console.log(`LOINC ${r.version ?? '(version unknown)'}: ${r.codes} codes loaded (${parts})${files.mapToFile ? ', with MapTo replacements' : ''}`);
  }
  if (values.icd10cm) {
    const r = await loadIcd10cm({ file: values.icd10cm, version: values['icd10cm-version'] });
    console.log(`ICD-10-CM ${r.version ?? '(version unknown)'}: ${r.codes} codes loaded from the ${r.format} file (${r.headers} category headers)`);
  }
  console.log('Run `npm run revalidate` to re-check stored resources against the loaded releases.');
} catch (err) {
  console.error(`Load failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
