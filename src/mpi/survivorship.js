// Survivorship: build one golden Patient from the source Patients linked to a
// master record, recording every disagreement instead of silently picking a side.
// The policy is written up in README.md ("Conflict resolution"); this file is its
// executable form. Pure functions, no database.
//
// Source records are ranked most-recently-updated first (meta.lastUpdated as the
// source reported it), then by source priority, then by id for determinism.

import { canonicalJson } from '../fhir/canonical.js';
import { dateRange } from '../fhir/dates.js';
import { canonicalSystem } from '../terminology/systems.js';

/**
 * @param records [{ sourceId, priority, fhirId, lastUpdated: Date|null, resource }]
 * @param overrides steward-pinned element values, applied last ({ element: value|null })
 * @returns {{ golden, conflicts, needsReview }}
 */
export function survive(records, overrides = {}, { masterId, linkUrl = (r) => `Patient/${r.fhirId}` } = {}) {
  const ranked = [...records].sort(byRank);
  const conflicts = [];
  const golden = { resourceType: 'Patient', id: masterId };

  golden.identifier = unionBy(ranked, (p) => p.identifier, identifierKey).map((id) => ({ ...id, system: canonicalIdentifierSystem(id.system) ?? undefined }));
  identifierConflicts(ranked, conflicts);

  golden.active = ranked.length > 0 && ranked.some((r) => r.resource.active !== false);
  golden.name = unionBy(ranked, (p) => p.name, nameKey);
  singleValueConflict(ranked, 'name', (p) => officialName(p), personNameKey, 'normal', conflicts, 'most-recent-source');

  golden.telecom = unionBy(ranked, (p) => p.telecom, telecomKey);
  telecomConflicts(ranked, conflicts);

  golden.gender = pickSingle(ranked, 'gender', (p) => p.gender, (v) => v, 'high', conflicts);
  golden.birthDate = pickBirthDate(ranked, conflicts);
  Object.assign(golden, pickDeceased(ranked, conflicts));

  golden.address = pickAddresses(ranked, conflicts);
  golden.maritalStatus = pickSingle(ranked, 'maritalStatus', (p) => p.maritalStatus, codeableKey, 'normal', conflicts);
  Object.assign(golden, pickChoice(ranked, 'multipleBirth', conflicts));
  golden.communication = unionBy(ranked, (p) => p.communication, (c) => codeableKey(c.language));
  golden.extension = pickExtensions(ranked, conflicts);

  // References (generalPractitioner, managingOrganization, link) point into one
  // source's id space and would dangle here; the golden record links to its sources instead.
  golden.link = ranked.map((r) => ({ other: { reference: linkUrl(r), display: r.sourceId }, type: 'seealso' }));

  for (const [element, value] of Object.entries(overrides ?? {})) {
    // Pinning one variant of a choice element (deceasedBoolean) replaces the other (deceasedDateTime).
    const family = CHOICE_FAMILIES.find((f) => element.startsWith(f));
    if (family) for (const key of Object.keys(golden)) if (key.startsWith(family)) delete golden[key];
    if (value === null) delete golden[element];
    else golden[element] = value;
    for (const c of conflicts) if (coveredBy(c.element, element)) c.resolvedBy = 'steward-override';
  }

  for (const key of Object.keys(golden)) {
    if (golden[key] === undefined || (Array.isArray(golden[key]) && golden[key].length === 0)) delete golden[key];
  }
  const needsReview = conflicts.some((c) => c.severity === 'high' && !c.resolvedBy);
  return { golden, conflicts, needsReview };
}

const CHOICE_FAMILIES = ['deceased', 'multipleBirth'];

/** Does an override of `element` settle a conflict recorded as `conflictElement`? */
function coveredBy(conflictElement, element) {
  const base = conflictElement.replace('[x]', '');
  return (
    conflictElement === element ||
    conflictElement.startsWith(`${element}:`) ||
    conflictElement.startsWith(`${element}.`) ||
    (conflictElement.endsWith('[x]') && element.startsWith(base))
  );
}

function byRank(a, b) {
  const ta = a.lastUpdated?.getTime() ?? -Infinity;
  const tb = b.lastUpdated?.getTime() ?? -Infinity;
  if (ta !== tb) return tb - ta;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return `${a.sourceId}/${a.fhirId}`.localeCompare(`${b.sourceId}/${b.fhirId}`);
}

function candidate(record, value) {
  return { source: record.sourceId, fhirId: record.fhirId, lastUpdated: record.lastUpdated?.toISOString() ?? null, value };
}

/** Union of an array element across sources, first occurrence (best-ranked) wins. */
function unionBy(ranked, get, key) {
  const seen = new Map();
  for (const r of ranked) {
    for (const item of get(r.resource) ?? []) {
      const k = key(item);
      if (k && !seen.has(k)) seen.set(k, item);
    }
  }
  return [...seen.values()];
}

/**
 * One value per source; if sources disagree, the best-ranked wins and a conflict is recorded.
 * Missing is not a vote: a source that omits an element never erases another's value.
 */
function pickSingle(ranked, element, get, key, severity, conflicts, rule = 'most-recent-source') {
  const present = ranked.filter((r) => get(r.resource) !== undefined && get(r.resource) !== null);
  if (!present.length) return undefined;
  const chosen = get(present[0].resource);
  if (new Set(present.map((r) => canonicalJson(key(get(r.resource))))).size > 1) {
    conflicts.push({ element, severity, rule, chosen, candidates: present.map((r) => candidate(r, get(r.resource))) });
  }
  return chosen;
}

function singleValueConflict(ranked, element, get, key, severity, conflicts, rule) {
  const present = ranked.filter((r) => get(r.resource));
  if (new Set(present.map((r) => key(get(r.resource)))).size > 1) {
    conflicts.push({ element, severity, rule, chosen: get(present[0].resource), candidates: present.map((r) => candidate(r, get(r.resource))) });
  }
}

// birthDate: a less precise value that contains a more precise one is a refinement,
// not a conflict ('1954' and '1954-01-20' agree). Real disagreement is high severity.
function pickBirthDate(ranked, conflicts) {
  const present = ranked.filter((r) => dateRange(r.resource.birthDate));
  if (!present.length) return undefined;
  const byPrecision = [...present].sort((a, b) => b.resource.birthDate.length - a.resource.birthDate.length);
  const precise = byPrecision[0].resource.birthDate;
  const [ps, pe] = dateRange(precise);
  const consistent = present.every((r) => {
    const [s, e] = dateRange(r.resource.birthDate);
    return s <= ps && e >= pe;
  });
  if (consistent) return precise;
  const chosen = present[0].resource.birthDate;
  conflicts.push({
    element: 'birthDate',
    severity: 'high',
    rule: 'most-recent-source',
    chosen,
    candidates: present.map((r) => candidate(r, r.resource.birthDate)),
  });
  return chosen;
}

// deceased: an assertion of death from any source wins over silence or an older
// "alive"; for patient safety a false "alive" is the worse error. Alive-vs-dead
// disagreement is high severity; two sources that agree on death but not on
// the details prefer the one carrying a date.
function pickDeceased(ranked, conflicts) {
  const value = (p) =>
    p.deceasedDateTime !== undefined
      ? { deceasedDateTime: p.deceasedDateTime }
      : p.deceasedBoolean !== undefined
        ? { deceasedBoolean: p.deceasedBoolean }
        : null;
  const present = ranked.filter((r) => value(r.resource));
  if (!present.length) return {};
  const isDead = (r) => r.resource.deceasedDateTime !== undefined || r.resource.deceasedBoolean === true;
  const dead = present.filter(isDead);
  const chosen = dead.find((r) => r.resource.deceasedDateTime !== undefined) ?? dead[0] ?? present[0];
  if (new Set(present.map((r) => canonicalJson(value(r.resource)))).size > 1) {
    const aliveVsDead = dead.length > 0 && dead.length < present.length;
    conflicts.push({
      element: 'deceased[x]',
      severity: aliveVsDead ? 'high' : 'normal',
      rule: aliveVsDead ? 'deceased-assertion-wins' : 'most-specific-assertion',
      chosen: value(chosen.resource),
      candidates: present.map((r) => candidate(r, value(r.resource))),
    });
  }
  return value(chosen.resource);
}

function pickChoice(ranked, prefix, conflicts) {
  const value = (p) => {
    const key = Object.keys(p).find((k) => k.startsWith(prefix) && k !== prefix);
    return key ? { [key]: p[key] } : null;
  };
  const chosen = pickSingle(ranked, `${prefix}[x]`, value, (v) => v, 'normal', conflicts);
  return chosen ?? {};
}

// address: people move. The most recently updated source's addresses are current;
// different addresses from other sources are kept but marked use = 'old'.
function pickAddresses(ranked, conflicts) {
  const present = ranked.filter((r) => r.resource.address?.length);
  if (!present.length) return undefined;
  const current = present[0].resource.address;
  const currentKeys = new Set(current.map(addressKey));
  const older = unionBy(present.slice(1), (p) => p.address, addressKey).filter((a) => !currentKeys.has(addressKey(a)));
  if (older.length) {
    conflicts.push({
      element: 'address',
      severity: 'normal',
      rule: 'most-recent-source',
      chosen: current,
      candidates: present.map((r) => candidate(r, r.resource.address)),
    });
  }
  return [...current, ...older.map((a) => ({ ...a, use: 'old' }))];
}

// Extensions: one per URL (race, ethnicity, birth sex...), best-ranked source wins.
function pickExtensions(ranked, conflicts) {
  const byUrl = new Map();
  for (const r of ranked) {
    for (const ext of r.resource.extension ?? []) {
      if (!ext?.url) continue;
      if (!byUrl.has(ext.url)) byUrl.set(ext.url, []);
      byUrl.get(ext.url).push({ record: r, ext });
    }
  }
  const out = [];
  for (const [url, entries] of byUrl) {
    out.push(entries[0].ext);
    const distinct = new Set(entries.map((e) => canonicalJson(e.ext)));
    if (distinct.size > 1) {
      conflicts.push({
        element: `extension:${url}`,
        severity: 'normal',
        rule: 'most-recent-source',
        chosen: entries[0].ext,
        candidates: entries.map((e) => candidate(e.record, e.ext)),
      });
    }
  }
  return out;
}

// --- identity keys: what counts as "the same value" across sources

const norm = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export function identifierKey(id) {
  if (!id?.value) return null;
  const system = canonicalIdentifierSystem(id.system);
  const value = system === SSN ? id.value.replace(/\D/g, '') : id.value.trim();
  return `${system ?? ''}|${value}`;
}

export const SSN = 'http://hl7.org/fhir/sid/us-ssn';
export function canonicalIdentifierSystem(system) {
  return system === 'urn:oid:2.16.840.1.113883.4.1' ? SSN : (system ?? null);
}

function identifierConflicts(ranked, conflicts) {
  // Two different SSNs for one person is a red flag for a bad link, not a merge detail.
  const ssns = ranked.flatMap((r) => (r.resource.identifier ?? []).filter((i) => canonicalIdentifierSystem(i.system) === SSN).map((i) => ({ r, i })));
  if (new Set(ssns.map(({ i }) => identifierKey(i))).size > 1) {
    conflicts.push({
      element: 'identifier:ssn',
      severity: 'high',
      rule: 'union',
      chosen: null,
      candidates: ssns.map(({ r, i }) => candidate(r, i.value)),
    });
  }
}

function nameKey(name) {
  if (!name) return null;
  return `${name.use ?? ''}|${norm(name.family)}|${(name.given ?? []).map(norm).join(' ')}`;
}

// For conflicts, only the person's name matters, not how a source labeled its use.
function personNameKey(name) {
  return name ? `${norm(name.family)}|${(name.given ?? []).map(norm).join(' ')}` : null;
}

function officialName(p) {
  const names = p.name ?? [];
  return names.find((n) => n.use === 'official') ?? names.find((n) => n.use === 'usual') ?? names.find((n) => !n.use) ?? names[0];
}

function telecomKey(t) {
  if (!t?.value) return null;
  const value = t.system === 'phone' || t.system === 'fax' || t.system === 'sms' ? t.value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') : t.value.trim().toLowerCase();
  return `${t.system ?? ''}|${value}`;
}

function telecomConflicts(ranked, conflicts) {
  // Same system and use, different values across sources: e.g. two "home phone" numbers.
  const bySlot = new Map();
  for (const r of ranked) {
    for (const t of r.resource.telecom ?? []) {
      const slot = `${t.system ?? ''}:${t.use ?? ''}`;
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push({ r, t });
    }
  }
  for (const [slot, entries] of bySlot) {
    if (new Set(entries.map(({ t }) => telecomKey(t))).size > 1 && new Set(entries.map(({ r }) => r.sourceId)).size > 1) {
      conflicts.push({
        element: `telecom:${slot}`,
        severity: 'normal',
        rule: 'union',
        chosen: entries[0].t.value,
        candidates: entries.map(({ r, t }) => candidate(r, t.value)),
      });
    }
  }
}

function addressKey(a) {
  if (!a) return null;
  return [(a.line ?? []).map(norm).join(' '), norm(a.city), norm(a.state), String(a.postalCode ?? '').slice(0, 5)].join('|');
}

function codeableKey(cc) {
  if (!cc) return null;
  const coding = (cc.coding ?? []).map((c) => `${canonicalSystem(c.system)}|${c.code}`).sort();
  return coding.length ? coding.join(',') : norm(cc.text);
}
