// Units: map what sources actually send onto UCUM codes, then convert to a
// concept's canonical unit. Deliberately not a general UCUM engine: each concept
// lists the source units it accepts and exactly how each one converts
// (src/terminology/concepts.js), so every conversion is reviewable in one place.

import { canonicalSystem, UCUM } from './systems.js';

// Lowercased spellings seen in real feeds -> UCUM case-sensitive code.
const SYNONYMS = new Map(
  Object.entries({
    '%': '%',
    percent: '%',
    '1': '1',
    '{ratio}': '1',
    'mg/dl': 'mg/dL',
    'g/dl': 'g/dL',
    'g/l': 'g/L',
    'mmol/l': 'mmol/L',
    'umol/l': 'umol/L',
    'µmol/l': 'umol/L',
    'μmol/l': 'umol/L',
    'mmol/mol': 'mmol/mol',
    kg: 'kg',
    g: 'g',
    '[lb_av]': '[lb_av]',
    lb: '[lb_av]',
    lbs: '[lb_av]',
    '[oz_av]': '[oz_av]',
    oz: '[oz_av]',
    cm: 'cm',
    m: 'm',
    mm: 'mm',
    '[in_i]': '[in_i]',
    '[in_us]': '[in_i]',
    in: '[in_i]',
    inch: '[in_i]',
    inches: '[in_i]',
    '[ft_i]': '[ft_i]',
    ft: '[ft_i]',
    cel: 'Cel',
    '°c': 'Cel',
    degc: 'Cel',
    '[degf]': '[degF]',
    '°f': '[degF]',
    degf: '[degF]',
    k: 'K',
    'mm[hg]': 'mm[Hg]',
    mmhg: 'mm[Hg]',
    kpa: 'kPa',
    '/min': '/min',
    '1/min': '/min',
    '{beats}/min': '/min',
    'beats/min': '/min',
    bpm: '/min',
    '{breaths}/min': '/min',
    '{counts}/min': '/min', // LOINC's example unit for heart and respiratory rate
    'ml/min': 'mL/min',
    'breaths/min': '/min',
    'kg/m2': 'kg/m2',
    'kg/m^2': 'kg/m2',
    'kg/m²': 'kg/m2',
    'ml/min/{1.73_m2}': 'mL/min/{1.73_m2}',
    'ml/min/1.73m2': 'mL/min/{1.73_m2}',
    'ml/min/1.73 m2': 'mL/min/{1.73_m2}',
    'ml/min/1.73m^2': 'mL/min/{1.73_m2}',
    'ml/min/{1.73m2}': 'mL/min/{1.73_m2}',
    'mg/g': 'mg/g',
    'mg/g{creat}': 'mg/g',
    'ug/mg': 'mg/g',
    'ug/mg{creat}': 'mg/g',
    'mg/mmol': 'mg/mmol',
    'mg/mmol{creat}': 'mg/mmol',
  }),
);

/**
 * The UCUM code for a Quantity, and whether the source coded it properly
 * (system = UCUM with a code) or we had to infer it from free text.
 */
export function quantityUnit(quantity) {
  if (!quantity) return { ucum: null, coded: false };
  const coded = canonicalSystem(quantity.system) === UCUM && typeof quantity.code === 'string';
  for (const candidate of [coded ? quantity.code : null, quantity.code, quantity.unit]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const ucum = SYNONYMS.get(candidate.trim().toLowerCase()) ?? (coded ? candidate.trim() : null);
    if (ucum) return { ucum, coded };
  }
  return { ucum: null, coded };
}

export const identity = { convert: (v) => v, label: null };
export const scale = (factor, label) => ({ convert: (v) => v * factor, label });

/**
 * Convert a FHIR Quantity to a concept's canonical unit.
 * Returns { value, unit, comparator, conversion } or { value: null, reason }.
 */
export function toCanonical(quantity, concept) {
  if (!quantity || typeof quantity.value !== 'number') return { value: null, reason: 'no-numeric-value' };
  const { ucum } = quantityUnit(quantity);
  if (!ucum) return { value: null, reason: 'unit-missing' };
  const rule = concept.units?.[ucum];
  if (!rule) return { value: null, reason: 'unit-not-convertible', sourceUnit: ucum };
  const value = round(rule.convert(quantity.value), concept.precision ?? 2);
  return {
    value,
    unit: concept.unit,
    comparator: quantity.comparator,
    conversion: rule.label ? `${rule.label}` : null,
  };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
