// FHIR date/dateTime values carry their own precision: '2024' means the whole
// year and '2024-03' the whole month. Date filters compare ranges, so a value is
// mapped to the UTC instant range it covers. Dates without a time have no zone
// in FHIR; they are read as UTC.

const PARTIAL = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/;

/** [start, end] (inclusive) Date range covered by a FHIR date/dateTime/instant, or null. */
export function dateRange(value) {
  if (typeof value !== 'string') return null;
  const partial = PARTIAL.exec(value);
  if (partial) {
    const [, y, m, d] = partial;
    const year = Number(y);
    if (!m) return [new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year + 1, 0, 1) - 1)];
    const month = Number(m) - 1;
    if (!d) return [new Date(Date.UTC(year, month, 1)), new Date(Date.UTC(year, month + 1, 1) - 1)];
    const start = new Date(Date.UTC(year, month, Number(d)));
    if (start.getUTCMonth() !== month) return null; // 2023-02-30
    return [start, new Date(start.getTime() + 86_400_000 - 1)];
  }
  // A time without an offset is invalid FHIR; read it as UTC rather than server-local time.
  const withZone = /T[\d:.]+$/.test(value) ? `${value}Z` : value;
  const t = Date.parse(withZone);
  if (Number.isNaN(t)) return null;
  return [new Date(t), new Date(t)];
}

// Where each resource type keeps its clinically relevant time, most specific first.
const TIME_FIELDS = {
  Observation: ['effectiveDateTime', 'effectiveInstant', 'effectivePeriod', 'issued'],
  DiagnosticReport: ['effectiveDateTime', 'effectivePeriod', 'issued'],
  Condition: ['onsetDateTime', 'onsetPeriod', 'recordedDate'],
  AllergyIntolerance: ['onsetDateTime', 'onsetPeriod', 'recordedDate'],
  Encounter: ['period'],
  Procedure: ['performedDateTime', 'performedPeriod'],
  Immunization: ['occurrenceDateTime'],
  MedicationRequest: ['authoredOn'],
};

// Condition-like resources stay "current" until they abate.
const END_FIELDS = {
  Condition: ['abatementDateTime', 'abatementPeriod'],
  AllergyIntolerance: [],
};

/**
 * { start, end } for a resource's clinical time; end is null when the range is
 * open (an ongoing Period, an unresolved Condition).
 */
export function clinicalTime(resource) {
  const fields = TIME_FIELDS[resource?.resourceType];
  if (!fields) return null;
  for (const field of fields) {
    const value = resource[field];
    if (value === undefined) continue;
    if (typeof value === 'object') {
      const start = dateRange(value.start)?.[0] ?? null;
      const end = dateRange(value.end)?.[1] ?? null;
      if (start || end) return { start: start ?? end, end };
      continue;
    }
    const range = dateRange(value);
    if (!range) continue;
    if (resource.resourceType in END_FIELDS) return { start: range[0], end: abatementEnd(resource) };
    return { start: range[0], end: range[1] };
  }
  return null;
}

function abatementEnd(resource) {
  for (const field of END_FIELDS[resource.resourceType] ?? []) {
    const value = resource[field];
    if (!value) continue;
    const end = typeof value === 'object' ? dateRange(value.end)?.[1] : dateRange(value)?.[1];
    if (end) return end;
  }
  return null;
}
