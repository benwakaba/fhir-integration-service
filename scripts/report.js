// Print a source's conformance report (the same data as GET /conformance/:source).
//
//   npm run report -- --source smart
//   npm run report -- --source hapi --json

import { parseArgs } from 'node:util';
import pool from '../src/db/pool.js';
import { conformanceReport } from '../src/validation/report.js';

const { values } = parseArgs({ options: { source: { type: 'string', default: 'smart' }, json: { type: 'boolean', default: false } } });

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const lpad = (s, n) => String(s).padStart(n);

try {
  const r = await conformanceReport(pool, values.source);
  if (values.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`\nConformance report: ${r.source.name} (${r.source.id})`);
    console.log(`Rules: ${r.rulesFrom.join(', ')}`);
    console.log(`Resources: ${Object.entries(r.resources).map(([t, n]) => `${n} ${t}`).join(', ')}\n`);

    console.log('Findings');
    r.findings.forEach((f, i) => console.log(`  ${lpad(i + 1, 2)}. ${f}`));

    console.log('\nResources with error-severity issues');
    for (const [type, v] of Object.entries(r.validation.resourcesWithErrors)) console.log(`  ${pad(type, 20)} ${lpad(v.resources, 6)}  ${lpad(v.pct, 5)}%`);
    if (!Object.keys(r.validation.resourcesWithErrors).length) console.log('  none');

    console.log('\nTop issues                                      resources     %  element');
    for (const i of r.validation.issues.slice(0, 15)) {
      console.log(`  ${pad(`${i.severity} ${i.category}/${i.rule}`, 44)} ${lpad(i.resources, 6)} ${lpad(i.pct, 5)}  ${i.element}`);
    }

    console.log('\nUS Core element coverage (below 100%; * = required, c = conditional)');
    for (const p of r.coverage) {
      const gaps = p.elements.filter((e) => e.pct < 100);
      if (!gaps.length) continue;
      console.log(`  ${p.profile} (${p.resources} ${p.resourceType})`);
      for (const e of gaps) {
        const flag = e.required ? '*' : e.conditional ? 'c' : ' ';
        console.log(`    ${flag} ${pad(e.element, 58)} ${lpad(`${e.present}/${e.of}`, 11)} ${lpad(e.pct, 5)}%${e.uscdi && !e.mustSupport ? '  (USCDI)' : ''}`);
      }
    }

    console.log('\nTerminology');
    for (const [element, t] of Object.entries(r.terminology)) {
      if (t.mappedToConcept) console.log(`  ${element}: ${t.mappedToConcept.pct}% of ${t.resources} map to an internal concept${t.snomedOnly ? `; ${t.snomedOnly.pct}% SNOMED-only` : ''}`);
      if (t.ucumCoded) console.log(`  ${element}: ${t.ucumCoded.pct}% of ${t.resources} carry a UCUM-coded unit`);
      for (const s of t.systems ?? []) console.log(`    ${lpad(s.pct, 5)}%  ${s.system}${s.alias ? `  (alias of ${s.canonical})` : ''}`);
    }

    console.log('\nTerminology backlog (codes that reach no concept; GET /terminology/backlog for all)');
    for (const [element, t] of Object.entries(r.terminology)) {
      if (!t.topUnmapped?.length) continue;
      console.log(`  ${element}`);
      for (const u of t.topUnmapped) {
        console.log(`    ${lpad(u.resources, 6)}  ${pad(u.kind, 18)} ${pad(u.code, 12)} ${pad(u.display ?? '', 56)}`);
      }
    }
  }
} catch (err) {
  console.error(`Report failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
