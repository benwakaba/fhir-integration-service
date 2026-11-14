// Per-source conformance summary: what a source actually sends, measured three ways.
//   validation   - issues on current versions, by category, rule and element
//   coverage     - how often US Core Must Support / USCDI elements are populated
//   terminology  - code systems in use, aliases, and how much maps to a concept
// Everything is computed in SQL over the stored JSON (jsonpath @? for element
// presence), so the report reflects the store as it is, not a cached tally.

import { normalizedCodings, reachesConcept, terminologyBacklog } from '../terminology/backlog.js';
import { CODE_SYSTEMS, normalizeCoding, SNOMED } from '../terminology/systems.js';
import { quantityUnit } from '../terminology/units.js';
import { RULES } from './rules.js';
import { getSource } from '../ingest/sources.js';

// Which US Core profile a stored resource is measured against. Conditions without
// an encounter-diagnosis category are measured as problems, so a missing category
// shows up as a coverage gap instead of the resource escaping measurement.
const PROFILE_SELECTORS = [
  { profile: 'us-core-patient', type: 'Patient' },
  { profile: 'us-core-condition-encounter-diagnosis', type: 'Condition', where: { category: [{ coding: [{ code: 'encounter-diagnosis' }] }] } },
  { profile: 'us-core-condition-problems-health-concerns', type: 'Condition', whereNot: { category: [{ coding: [{ code: 'encounter-diagnosis' }] }] } },
  { profile: 'us-core-observation-lab', type: 'Observation', where: { category: [{ coding: [{ code: 'laboratory' }] }] } },
  { profile: 'us-core-vital-signs', type: 'Observation', where: { category: [{ coding: [{ code: 'vital-signs' }] }] } },
  { profile: 'us-core-encounter', type: 'Encounter' },
  { profile: 'us-core-allergyintolerance', type: 'AllergyIntolerance' },
  { profile: 'us-core-immunization', type: 'Immunization' },
  { profile: 'us-core-medicationrequest', type: 'MedicationRequest' },
  { profile: 'us-core-procedure', type: 'Procedure' },
];

const COVERAGE_GAP = 90; // % below which an element is reported as a finding

export async function conformanceReport(db, sourceId) {
  const source = await getSource(db, sourceId);
  const { rows: counts } = await db.query(
    `SELECT resource_type, count(*)::int AS n FROM resources WHERE source_id = $1 AND NOT deleted GROUP BY 1 ORDER BY 2 DESC`,
    [sourceId],
  );
  const totals = Object.fromEntries(counts.map((r) => [r.resource_type, r.n]));
  const validation = await validationSummary(db, sourceId, totals);
  const coverage = await coverageSummary(db, sourceId);
  const terminology = await terminologySummary(db, sourceId, totals);
  return {
    source: { id: source.id, name: source.name, baseUrl: source.base_url },
    generatedAt: new Date().toISOString(),
    rulesFrom: RULES.generatedFrom,
    resources: totals,
    findings: findings(source.id, validation, coverage, terminology),
    validation,
    coverage,
    terminology,
  };
}

async function validationSummary(db, sourceId, totals) {
  const { rows } = await db.query(
    `SELECT r.resource_type, vi.severity, vi.category, vi.rule, vi.element,
            count(*)::int AS occurrences,
            count(DISTINCT r.id)::int AS resources,
            (array_agg(vi.message ORDER BY vi.id))[1] AS example,
            (array_agg(DISTINCT vi.message))[1:8] AS examples,
            count(DISTINCT vi.message)::int AS distinct_examples,
            (array_agg(r.fhir_id ORDER BY vi.id))[1] AS example_id
     FROM validation_issues vi
     JOIN resources r ON r.id = vi.resource_id AND r.version_id = vi.version_id
     WHERE r.source_id = $1 AND NOT r.deleted
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY resources DESC, occurrences DESC`,
    [sourceId],
  );
  const { rows: byCategory } = await db.query(
    `SELECT r.resource_type, vi.category, count(DISTINCT r.id)::int AS resources
     FROM validation_issues vi
     JOIN resources r ON r.id = vi.resource_id AND r.version_id = vi.version_id
     WHERE r.source_id = $1 AND NOT r.deleted
     GROUP BY 1, 2`,
    [sourceId],
  );
  const { rows: withErrors } = await db.query(
    `SELECT r.resource_type, count(DISTINCT r.id)::int AS resources
     FROM validation_issues vi
     JOIN resources r ON r.id = vi.resource_id AND r.version_id = vi.version_id
     WHERE r.source_id = $1 AND NOT r.deleted AND vi.severity = 'error'
     GROUP BY 1`,
    [sourceId],
  );
  const categories = {};
  for (const row of byCategory) {
    categories[row.category] ??= {};
    categories[row.category][row.resource_type] = { resources: row.resources, pct: pct(row.resources, totals[row.resource_type]) };
  }
  return {
    resourcesWithErrors: Object.fromEntries(withErrors.map((r) => [r.resource_type, { resources: r.resources, pct: pct(r.resources, totals[r.resource_type]) }])),
    byCategory: categories,
    issues: rows.map((r) => ({
      resourceType: r.resource_type,
      severity: r.severity,
      category: r.category,
      rule: r.rule,
      element: r.element,
      resources: r.resources,
      pct: pct(r.resources, totals[r.resource_type]),
      occurrences: r.occurrences,
      example: r.example,
      examples: r.examples,
      distinctExamples: r.distinct_examples,
      exampleId: `${r.resource_type}/${r.example_id}`,
    })),
  };
}

// Elements that are only populated when the clinical situation calls for them, so
// their absence says nothing about the source: a data-absent reason exists only when
// the value does not, components only on panels, abatement only once resolved.
const CONDITIONAL = new Set([
  'Observation.dataAbsentReason',
  'Observation.component',
  'Observation.value[x]',
  'Observation.component.dataAbsentReason',
  'Observation.component.value[x]',
  'Condition.abatement[x]',
  'Patient.deceased[x]',
  'Patient.extension:tribalAffiliation',
  'Patient.name.suffix',
  'Patient.name.period',
  'Patient.address.period',
  'Encounter.hospitalization',
  'Encounter.hospitalization.dischargeDisposition',
  'Encounter.reasonReference',
  'Encounter.participant.period',
]);

// US Core us-core-2: an Observation needs a result of some kind. Measured as one
// synthetic element because value[x], component and dataAbsentReason are alternatives.
const RESULT = {
  path: 'Observation.(value[x] | component | hasMember | dataAbsentReason)',
  min: 1,
  mustSupport: true,
  uscdi: false,
  jsonpath: '$.keyvalue() ? (@.key starts with "value" || @.key == "component" || @.key == "hasMember" || @.key == "dataAbsentReason")',
};

async function coverageSummary(db, sourceId) {
  const out = [];
  for (const sel of PROFILE_SELECTORS) {
    const profile = RULES.mustSupport[sel.profile];
    const elements = sel.type === 'Observation' ? [RESULT, ...profile.elements] : profile.elements;
    const params = [sourceId, sel.type];
    const filters = [];
    if (sel.where) filters.push(`AND r.resource @> $${params.push(JSON.stringify(sel.where))}::jsonb`);
    if (sel.whereNot) filters.push(`AND NOT r.resource @> $${params.push(JSON.stringify(sel.whereNot))}::jsonb`);
    // Nested elements are measured among resources that have their parent:
    // Patient.communication.language counts only Patients that have a communication.
    const columns = elements.map((el, i) => {
      const present = `count(*) FILTER (WHERE r.resource @? $${params.push(el.jsonpath ?? presencePath(el))}::jsonpath)::int AS e${i}`;
      const parent = parentOf(el, profile.elements);
      const base = parent ? `count(*) FILTER (WHERE r.resource @? $${params.push(presencePath(parent))}::jsonpath)::int` : 'count(*)::int';
      return `${present}, ${base} AS b${i}`;
    });
    const { rows } = await db.query(
      `SELECT count(*)::int AS total, ${columns.join(', ')}
       FROM resources r
       WHERE r.source_id = $1 AND r.resource_type = $2 AND NOT r.deleted ${filters.join(' ')}`,
      params,
    );
    const total = rows[0].total;
    if (!total) continue;
    out.push({
      profile: sel.profile,
      profileUrl: profile.url,
      resourceType: sel.type,
      resources: total,
      elements: elements
        .map((el, i) => ({
          element: el.path,
          required: el.min >= 1,
          mustSupport: el.mustSupport,
          uscdi: el.uscdi,
          conditional: CONDITIONAL.has(el.path),
          ...(parentOf(el, profile.elements) && { among: parentOf(el, profile.elements).path }),
          present: rows[0][`e${i}`],
          of: rows[0][`b${i}`],
          pct: pct(rows[0][`e${i}`], rows[0][`b${i}`]),
        }))
        .filter((el) => el.of > 0)
        .sort((a, b) => a.pct - b.pct),
    });
  }
  return out;
}

function parentOf(el, elements) {
  if (el.jsonpath) return null;
  const parts = el.path.split('.');
  if (parts.length <= 2) return null;
  const parentPath = parts.slice(0, -1).join('.');
  return elements.find((e) => e.path === parentPath) ?? { path: parentPath };
}

/**
 * jsonpath that is true when an element is populated. Lax mode unwraps arrays, so
 * '$.communication.language' holds if any communication has a language.
 */
export function presencePath(el) {
  const steps = el.path.split('.').slice(1);
  let path = '$';
  for (const step of steps) {
    if (step.startsWith('extension:')) {
      path += `.extension ? (@.url == ${JSON.stringify(el.extensionUrl)})`;
    } else if (step.endsWith('[x]')) {
      const prefix = step.slice(0, -3);
      path += `.keyvalue() ? (@.key starts with ${JSON.stringify(prefix)} && @.key != ${JSON.stringify(prefix)})`;
    } else {
      path += `.${JSON.stringify(step)}`;
    }
  }
  return path;
}

async function terminologySummary(db, sourceId, totals) {
  const { rows } = await db.query(
    `SELECT r.resource_type, r.resource->'code'->'coding' AS codings,
            jsonb_path_query_array(r.resource, '$.component[*].code.coding[*]') AS component_codings,
            r.resource->'valueQuantity' AS quantity
     FROM resources r
     WHERE r.source_id = $1 AND NOT r.deleted AND r.resource_type IN ('Observation', 'Condition')`,
    [sourceId],
  );
  const summary = {};
  for (const type of ['Observation', 'Condition']) {
    const typed = rows.filter((r) => r.resource_type === type);
    if (!typed.length) continue;
    const domain = type === 'Observation' ? 'observation' : 'condition';
    const systems = new Map();
    let mapped = 0;
    let snomedOnly = 0;
    let quantities = 0;
    let ucumCoded = 0;
    for (const row of typed) {
      const codings = Array.isArray(row.codings) ? row.codings : [];
      const normalized = codings.map((c) => ({ raw: c?.system ?? null, ...normalizeCoding(c) }));
      for (const n of normalized) {
        const key = n.raw ?? '(none)';
        const entry = systems.get(key) ?? { system: key, canonical: n.system, name: CODE_SYSTEMS[n.system]?.name ?? null, alias: n.problems.includes('system-alias'), resources: new Set() };
        entry.resources.add(row);
        systems.set(key, entry);
      }
      // Mapped means reachable: through the resource's own code or, for a panel, a component's.
      if (reachesConcept([...normalized, ...normalizedCodings(row.component_codings)], domain)) mapped++;
      if (normalized.length && normalized.every((n) => n.system === SNOMED)) snomedOnly++;
      if (row.quantity) {
        quantities++;
        if (quantityUnit(row.quantity).coded) ucumCoded++;
      }
    }
    summary[`${type}.code`] = {
      resources: typed.length,
      mappedToConcept: { resources: mapped, pct: pct(mapped, typed.length) },
      ...(type === 'Condition' && { snomedOnly: { resources: snomedOnly, pct: pct(snomedOnly, typed.length) } }),
      systems: [...systems.values()]
        .map((s) => ({ system: s.system, canonical: s.canonical, name: s.name, alias: s.alias, resources: s.resources.size, pct: pct(s.resources.size, typed.length) }))
        .sort((a, b) => b.resources - a.resources),
      // The head of GET /terminology/backlog: what to map next for this source.
      topUnmapped: (await terminologyBacklog(db, { resourceType: type, source: sourceId, limit: 5 })).backlog,
    };
    if (type === 'Observation' && quantities) {
      summary['Observation.valueQuantity'] = { resources: quantities, ucumCoded: { resources: ucumCoded, pct: pct(ucumCoded, quantities) } };
    }
  }
  return summary;
}

// The headline sentences: the facts an integration engineer would act on. Ranked
// by how many resources each affects, but within groups, so that a coverage gap in
// 20,000 Observations cannot crowd out 15 Conditions coded with invalid codes.
const FINDING_QUOTA = { coverage: 8, codes: 9, structure: 5 };

// Code-level issues worth a headline, with how to say them.
const CODE_RULES = {
  'unknown-code': (n) => `use codes that do not exist in the loaded release`,
  'non-billable-code': () => 'use ICD-10-CM category headers, which are not codable diagnoses',
  'loinc-check-digit': () => 'carry LOINC codes that fail the check digit',
  'malformed-code': () => 'carry malformed codes',
  'deprecated-code': () => 'use deprecated codes',
  'discouraged-code': () => 'use codes LOINC now discourages',
  'required-binding': (issue) => `have no coding from the required value set at ${issue.element}`,
  'non-canonical-system': (issue) => `use non-canonical system URIs at ${issue.element}`,
};

// Elements whose system aliases are already reported from the terminology summary.
const SUMMARIZED = new Set(['Observation.code.coding.system', 'Condition.code.coding.system']);

function findings(sourceId, validation, coverage, terminology) {
  const groups = { coverage: [], codes: [], structure: [] };

  for (const profile of coverage) {
    for (const el of profile.elements) {
      // Required elements must always be there; "populate if known" elements are
      // reported below COVERAGE_GAP; conditional ones never.
      if (el.conditional || el.pct >= (el.required ? 100 : COVERAGE_GAP)) continue;
      const flag = el.required ? `required by ${profile.profile}` : `${el.mustSupport ? 'US Core Must Support' : 'USCDI requirement'}, ${profile.profile}`;
      const scope = el.among ? `${profile.resourceType} resources that have ${el.among}` : `${profile.resourceType} resources`;
      groups.coverage.push({
        // A missing required element makes the resource non-conformant; a missing
        // "populate if known" element may just be unknown data. Required ranks first.
        weight: (100 - el.pct) * el.of * (el.required ? 10 : 1),
        text: `${sourceId} omits ${el.element} in ${round(100 - el.pct)}% of ${scope} (${flag})`,
      });
    }
  }

  const extensions = new Map(); // resourceType -> { resources, pct, urls }
  for (const issue of validation.issues) {
    if (issue.category === 'unknown-extension') {
      const entry = extensions.get(issue.resourceType) ?? { resources: 0, pct: 0, urls: [] };
      entry.resources = Math.max(entry.resources, issue.resources);
      entry.pct = Math.max(entry.pct, issue.pct);
      entry.urls.push(/\('(.+)'\)$/.exec(issue.element)?.[1] ?? issue.element);
      extensions.set(issue.resourceType, entry);
      continue;
    }
    const describe = CODE_RULES[issue.rule];
    if (describe && !(issue.rule === 'non-canonical-system' && SUMMARIZED.has(issue.element))) {
      const codes = [...new Set((issue.examples ?? []).map((m) => /'([^']+)'/.exec(m)?.[1]).filter(Boolean))];
      const more = issue.distinctExamples - codes.length;
      const list = issue.rule === 'required-binding' || issue.rule === 'non-canonical-system' ? '' : `: ${codes.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
      groups.codes.push({
        weight: issue.resources * (issue.severity === 'error' ? 100 : 60),
        text: `${issue.resources} ${issue.resourceType} resources (${shown(issue.pct, issue.resources)}%) ${describe(issue)}${list}`,
      });
    } else if (issue.severity === 'error') {
      groups.structure.push({
        weight: issue.resources * 100,
        text: `${shown(issue.pct, issue.resources)}% of ${issue.resourceType} resources (${issue.resources}) have ${issue.category} at ${issue.element}: ${issue.example}`,
      });
    }
  }
  for (const [type, e] of extensions) {
    const urls = e.urls.slice(0, 3).join(', ');
    groups.structure.push({
      weight: e.resources * 50,
      text: `${shown(e.pct, e.resources)}% of ${type} resources (${e.resources}) carry extensions defined in neither FHIR R4 core nor US Core 6.1.0: ${urls}${e.urls.length > 3 ? ` (+${e.urls.length - 3} more)` : ''}`,
    });
  }

  const conditions = terminology['Condition.code'];
  if (conditions?.snomedOnly?.resources) {
    groups.codes.push({
      weight: conditions.snomedOnly.resources * 60,
      text: `${conditions.snomedOnly.pct}% of Conditions are coded only in SNOMED CT and cannot be mapped to internal concepts until SNOMED is licensed`,
    });
  }
  // One line for every aliased system URI in use, however many there are.
  const aliases = Object.entries(terminology).flatMap(([element, t]) =>
    (t.systems ?? []).filter((x) => x.alias).map((x) => ({ ...x, type: element.split('.')[0] })),
  );
  if (aliases.length) {
    groups.codes.push({
      weight: aliases.reduce((n, a) => n + a.resources, 0) * 55,
      text: `Non-canonical system URIs: ${aliases.map((a) => `${a.resources} ${a.type} resources use '${a.system}' for ${a.name}`).join('; ')}`,
    });
  }
  const quantity = terminology['Observation.valueQuantity'];
  if (quantity && quantity.ucumCoded.pct < 95) {
    groups.codes.push({ weight: (100 - quantity.ucumCoded.pct) * quantity.resources, text: `${round(100 - quantity.ucumCoded.pct)}% of numeric Observations carry no UCUM-coded unit` });
  }

  const byWeight = (a, b) => b.weight - a.weight;
  return Object.entries(FINDING_QUOTA)
    .flatMap(([group, quota]) => groups[group].sort(byWeight).slice(0, quota))
    .sort(byWeight)
    .map((f) => f.text);
}

// A few resources out of thousands is not "0%".
function shown(pctValue, count) {
  return count > 0 && pctValue < 0.1 ? '<0.1' : String(pctValue);
}

function pct(n, total) {
  return total ? round((100 * n) / total) : 0;
}

function round(x) {
  return Math.round(x * 10) / 10;
}
