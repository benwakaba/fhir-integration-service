// The canonical concept catalog: internal concepts an application developer asks
// for ("hba1c", "type-2-diabetes") and every source code that means each one.
//
// Membership is curated, not derived by string-matching LOINC names, because the
// near misses are clinically wrong: 86910-7 is an HbA1c *goal*, not a result;
// 41995-2 is HbA1c mass concentration (g/dL), which cannot be expressed as the %
// used for diagnosis. Exclusions are recorded so a lookup can say why a code is
// not a member. LOINC members, names, statuses and example units are checked
// against the loaded LOINC release (npm run terminology:check; last run against
// 2.83); ICD-10-CM roots were verified against the NLM ICD-10-CM index and FY2026.
//
// This material contains content from LOINC (http://loinc.org). LOINC is copyright
// Regenstrief Institute, Inc. and the Logical Observation Identifiers Names and
// Codes (LOINC) Committee and is available at no cost under the license at
// http://loinc.org/license. LOINC® is a registered United States trademark of
// Regenstrief Institute, Inc.

import { ICD10CM, LOINC } from './systems.js';
import { identity, scale } from './units.js';

const loinc = (code, display, { note, status = 'active' } = {}) => ({ system: LOINC, code, display, match: 'exact', note, status });
// ICD-10-CM members are category roots by default: 'E11' covers E11 and every E11.x code.
const icd = (code, note, match = 'descendants') => ({ system: ICD10CM, code, match, note });
const exclude = (member, reason) => ({ ...member, reason });

const mmolPerL = (factor, analyte) => scale(factor, `mmol/L × ${factor} (${analyte})`);

const OBSERVATION_CONCEPTS = [
  {
    id: 'hba1c',
    display: 'Hemoglobin A1c',
    unit: '%',
    precision: 1,
    description:
      'Glycated hemoglobin as a fraction of total hemoglobin, in NGSP %. IFCC results (mmol/mol) are converted with the NGSP/IFCC master equation.',
    members: [
      loinc('4548-4', 'Hemoglobin A1c/Hemoglobin.total in Blood'),
      loinc('17856-6', 'Hemoglobin A1c/Hemoglobin.total in Blood by HPLC'),
      loinc('4549-2', 'Hemoglobin A1c/Hemoglobin.total in Blood by Electrophoresis'),
      loinc('17855-8', 'Hemoglobin A1c/Hemoglobin.total in Blood by calculation'),
      loinc('62388-4', 'Hemoglobin A1c/Hemoglobin.total in Blood by JDS/JSCC protocol'),
      loinc('96595-4', 'Hemoglobin A1c/Hemoglobin.total in DBS'),
      loinc('71875-9', 'Hemoglobin A1c/Hemoglobin.total [Pure mass fraction] in Blood', { note: 'Decimal fraction (0.065 = 6.5%)' }),
      loinc('59261-8', 'Hemoglobin A1c/Hemoglobin.total standardized per IFCC-RMP for CDT in Blood', { note: 'IFCC, mmol/mol' }),
      loinc('106634-9', 'Hemoglobin A1c/Hemoglobin.total [Molar ratio] in Blood by IFCC protocol', { note: 'Deprecated in LOINC; still present in older feeds', status: 'deprecated' }),
    ],
    excluded: [
      exclude(loinc('86910-7', 'Hemoglobin A1c/Hemoglobin.total goal Blood'), 'A treatment goal, not a measured result'),
      exclude(loinc('41995-2', 'Hemoglobin A1c [Mass/volume] in Blood'), 'Mass concentration (g/dL); not convertible to a fraction of total hemoglobin'),
      exclude(loinc('112870-1', 'Hemoglobin A1c and estimated average glucose panel - Blood'), 'Panel code; its member results are mapped individually'),
      exclude(loinc('55454-3', 'Hemoglobin A1c in Blood', { status: 'deprecated' }), 'Deprecated; LOINC maps it to 41995-2, a mass concentration'),
    ],
    units: {
      '%': identity,
      'mmol/mol': { convert: (v) => 0.09148 * v + 2.152, label: 'IFCC mmol/mol → NGSP % (NGSP = 0.09148 × IFCC + 2.152)' },
      '1': scale(100, 'decimal fraction × 100'),
    },
  },
  {
    id: 'glucose',
    display: 'Glucose',
    unit: 'mg/dL',
    precision: 0,
    description: 'Glucose concentration in blood (capillary, venous, arterial, mixed venous), serum or plasma; random, not fasting.',
    members: [
      loinc('2345-7', 'Glucose [Mass/volume] in Serum or Plasma'),
      loinc('14749-6', 'Glucose [Moles/volume] in Serum or Plasma'),
      loinc('2339-0', 'Glucose [Mass/volume] in Blood'),
      loinc('15074-8', 'Glucose [Moles/volume] in Blood'),
      loinc('74774-1', 'Glucose [Mass/volume] in Serum, Plasma or Blood'),
      loinc('77135-2', 'Glucose [Moles/volume] in Serum, Plasma or Blood'),
      loinc('32016-8', 'Glucose [Mass/volume] in Capillary blood'),
      loinc('51596-5', 'Glucose [Moles/volume] in Capillary blood'),
      loinc('41653-7', 'Glucose [Mass/volume] in Capillary blood by Glucometer'),
      loinc('14743-9', 'Glucose [Moles/volume] in Capillary blood by Glucometer'),
      loinc('41652-9', 'Glucose [Mass/volume] in Venous blood'),
      loinc('39480-9', 'Glucose [Moles/volume] in Venous blood'),
      loinc('104597-0', 'Glucose [Mass/volume] in Venous blood by Glucometer'),
      loinc('41651-1', 'Glucose [Mass/volume] in Arterial blood'),
      loinc('39481-7', 'Glucose [Moles/volume] in Arterial blood'),
      loinc('104598-8', 'Glucose [Mass/volume] in Arterial blood by Glucometer'),
      loinc('104655-6', 'Glucose [Mass/volume] in Mixed venous blood'),
      loinc('100746-7', 'Glucose [Moles/volume] in Mixed venous blood'),
      loinc('96594-7', 'Glucose [Mass/volume] in DBS'),
    ],
    excluded: [
      exclude(loinc('1558-6', 'Fasting glucose [Mass/volume] in Serum or Plasma'), 'Fasting glucose is its own concept (fasting-glucose)'),
      exclude(loinc('14771-0', 'Fasting glucose [Moles/volume] in Serum or Plasma'), 'Fasting glucose is its own concept (fasting-glucose)'),
      exclude(loinc('47995-6', 'Glucose [Moles/volume] in Cord blood'), 'Cord blood is sampled at delivery and describes the newborn'),
    ],
    units: {
      'mg/dL': identity,
      'mmol/L': mmolPerL(18.016, 'glucose, 180.16 g/mol'),
      'g/L': scale(100, 'g/L × 100'),
      'g/dL': scale(1000, 'g/dL × 1000'),
    },
  },
  {
    id: 'fasting-glucose',
    display: 'Fasting glucose',
    unit: 'mg/dL',
    precision: 0,
    description: 'Glucose after a caloric fast, as used for diabetes diagnosis.',
    members: [
      loinc('1558-6', 'Fasting glucose [Mass/volume] in Serum or Plasma'),
      loinc('14771-0', 'Fasting glucose [Moles/volume] in Serum or Plasma'),
    ],
    units: { 'mg/dL': identity, 'mmol/L': mmolPerL(18.016, 'glucose, 180.16 g/mol') },
  },
  {
    id: 'ldl-cholesterol',
    display: 'LDL cholesterol',
    unit: 'mg/dL',
    precision: 0,
    description: 'Cholesterol in LDL, measured directly or calculated (Friedewald, Martin-Hopkins).',
    members: [
      loinc('18262-6', 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by Direct assay'),
      loinc('13457-7', 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation'),
      loinc('2089-1', 'Cholesterol in LDL [Mass/volume] in Serum or Plasma'),
      loinc('96259-7', 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by Calculated by Martin-Hopkins'),
      loinc('18261-8', 'Cholesterol in LDL [Mass/volume] in Serum or Plasma ultracentrifugate', { note: 'Beta-quantification, the reference method' }),
      loinc('49132-4', 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by Electrophoresis'),
      loinc('96597-0', 'Cholesterol in LDL [Mass/volume] in DBS by Direct assay'),
      loinc('22748-8', 'Cholesterol in LDL [Moles/volume] in Serum or Plasma'),
      loinc('39469-2', 'Cholesterol in LDL [Moles/volume] in Serum or Plasma by calculation'),
      loinc('69419-0', 'Cholesterol in LDL [Moles/volume] in Serum or Plasma by Direct assay'),
      loinc('96258-9', 'Cholesterol in LDL [Moles/volume] in Serum or Plasma by Calculated by Martin-Hopkins'),
    ],
    excluded: [
      exclude(loinc('55440-2', 'Cholesterol.in LDL (real) [Mass/volume] in Serum or Plasma by VAP'), 'VAP "real" LDL excludes Lp(a) and IDL cholesterol; not comparable with LDL-C'),
      exclude(loinc('12773-8', 'Cholesterol in LDL [Units/volume] in Serum or Plasma by Electrophoresis'), 'Arbitrary units; not convertible to a concentration'),
    ],
    units: { 'mg/dL': identity, 'mmol/L': mmolPerL(38.67, 'cholesterol, 386.65 g/mol') },
  },
  {
    id: 'hdl-cholesterol',
    display: 'HDL cholesterol',
    unit: 'mg/dL',
    precision: 0,
    members: [
      loinc('2085-9', 'Cholesterol in HDL [Mass/volume] in Serum or Plasma'),
      loinc('14646-4', 'Cholesterol in HDL [Moles/volume] in Serum or Plasma'),
      loinc('18263-4', 'Cholesterol in HDL [Mass/volume] in Serum or Plasma ultracentrifugate'),
      loinc('49130-8', 'Cholesterol in HDL [Mass/volume] in Serum or Plasma by Electrophoresis'),
      loinc('96596-2', 'Cholesterol in HDL [Mass/volume] in DBS'),
    ],
    excluded: [exclude(loinc('12772-0', 'Cholesterol in HDL [Units/volume] in Serum or Plasma by Electrophoresis'), 'Arbitrary units; not convertible to a concentration')],
    units: { 'mg/dL': identity, 'mmol/L': mmolPerL(38.67, 'cholesterol, 386.65 g/mol') },
  },
  {
    id: 'total-cholesterol',
    display: 'Total cholesterol',
    unit: 'mg/dL',
    precision: 0,
    members: [
      loinc('2093-3', 'Cholesterol [Mass/volume] in Serum or Plasma'),
      loinc('14647-2', 'Cholesterol [Moles/volume] in Serum or Plasma'),
      loinc('48620-9', 'Cholesterol [Mass/volume] in Serum or Plasma ultracentrifugate'),
      loinc('96588-9', 'Cholesterol [Mass/volume] in DBS'),
    ],
    units: { 'mg/dL': identity, 'mmol/L': mmolPerL(38.67, 'cholesterol, 386.65 g/mol') },
  },
  {
    id: 'triglycerides',
    display: 'Triglycerides',
    unit: 'mg/dL',
    precision: 0,
    members: [
      loinc('2571-8', 'Triglyceride [Mass/volume] in Serum or Plasma'),
      loinc('12951-0', 'Triglyceride [Mass/volume] in Serum or Plasma by calculation'),
      loinc('3043-7', 'Triglyceride [Mass/volume] in Blood'),
      loinc('14927-8', 'Triglyceride [Moles/volume] in Serum or Plasma'),
      loinc('70218-3', 'Triglyceride [Moles/volume] in Blood'),
      loinc('96598-8', 'Triglyceride [Mass/volume] in DBS'),
    ],
    units: { 'mg/dL': identity, 'mmol/L': mmolPerL(88.57, 'triglyceride as triolein') },
  },
  {
    id: 'creatinine',
    display: 'Creatinine',
    unit: 'mg/dL',
    precision: 2,
    description: 'Creatinine in serum, plasma or blood (not urine).',
    members: [
      loinc('2160-0', 'Creatinine [Mass/volume] in Serum or Plasma'),
      loinc('14682-9', 'Creatinine [Moles/volume] in Serum or Plasma'),
      loinc('103616-9', 'Creatinine [Moles/volume] in Serum or Plasma by LC/MS/MS'),
      loinc('38483-4', 'Creatinine [Mass/volume] in Blood'),
      loinc('59826-8', 'Creatinine [Moles/volume] in Blood'),
      loinc('77140-2', 'Creatinine [Moles/volume] in Serum, Plasma or Blood'),
      loinc('101475-2', 'Creatinine [Moles/volume] in Venous blood'),
      loinc('21232-4', 'Creatinine [Mass/volume] in Arterial blood'),
      loinc('96590-5', 'Creatinine [Mass/volume] in DBS'),
    ],
    units: {
      'mg/dL': identity,
      'umol/L': scale(1 / 88.42, 'µmol/L ÷ 88.42 (creatinine, 113.12 g/mol)'),
      'mmol/L': scale(1000 / 88.42, 'mmol/L × 11.31 (creatinine, 113.12 g/mol)'),
    },
  },
  {
    id: 'egfr',
    display: 'Estimated glomerular filtration rate',
    unit: 'mL/min/{1.73_m2}',
    precision: 0,
    description:
      'eGFR normalized to 1.73 m² body surface area, by any estimating equation: creatinine (MDRD, CKD-EPI, pediatric Schwartz/CKiD), cystatin C, or both. Race-based variants are kept because legacy feeds still send them; CKD-EPI 2021 (creatinine 98979-8, creatinine-cystatin C 98980-6) is current and race-free.',
    members: [
      loinc('98980-6', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine and Cystatin C-based formula (CKD-EPI 2021)/1.73 sq M'),
      loinc('94677-2', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine and Cystatin C-based formula (CKD-EPI)/1.73 sq M'),
      loinc('50210-4', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Cystatin C-based formula/1.73 sq M'),
      loinc('77147-7', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (MDRD)/1.73 sq M'),
      loinc('70969-1', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (MDRD)/1.73 sq M among male population'),
      loinc('50384-7', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (Schwartz)/1.73 sq M', { note: 'Pediatric' }),
      loinc('102097-3', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine, Cystatin C and Urea-based formula (CKiD)/1.73 sq M', { note: 'Pediatric' }),
      loinc('96591-3', 'Glomerular filtration rate [Volume Rate/Area] in DBS by based on 1.73 sq M among black population', { note: 'Race-based equation' }),
      loinc('96592-1', 'Glomerular filtration rate [Volume Rate/Area] in DBS by based on 1.73 sq M among non black population', { note: 'Race-based equation' }),
      loinc('98979-8', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (CKD-EPI 2021)/1.73 sq M'),
      loinc('62238-1', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (CKD-EPI)/1.73 sq M'),
      loinc('33914-3', 'Glomerular filtration rate [Volume Rate/Area] in Serum or Plasma by Creatinine-based formula (MDRD)/1.73 sq M', { status: 'discouraged', note: 'Discouraged in LOINC 2.83; replaced by 77147-7' }),
      loinc('50044-7', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (MDRD)/1.73 sq M among female population'),
      loinc('69405-9', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by based on 1.73 sq M'),
      loinc('48642-3', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (MDRD)/1.73 sq M among non black population', { note: 'Race-based equation' }),
      loinc('48643-1', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (MDRD)/1.73 sq M among black population', { note: 'Race-based equation' }),
      loinc('88294-4', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (CKD-EPI)/1.73 sq M among non black population', { note: 'Race-based equation' }),
      loinc('88293-6', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (CKD-EPI)/1.73 sq M among black population', { note: 'Race-based equation' }),
    ],
    // These codes are normalized to 1.73 m² by definition; some feeds write the unit without it.
    units: { 'mL/min/{1.73_m2}': identity, 'mL/min': { convert: (v) => v, label: 'mL/min as sent; the code defines the /1.73 m² normalization' } },
  },
  {
    id: 'urine-albumin-creatinine-ratio',
    display: 'Urine albumin/creatinine ratio',
    unit: 'mg/g',
    precision: 1,
    members: [
      loinc('9318-7', 'Albumin/Creatinine [Mass Ratio] in Urine'),
      loinc('14959-1', 'Microalbumin/Creatinine [Mass Ratio] in Urine'),
      loinc('32294-1', 'Albumin/Creatinine [Ratio] in Urine'),
    ],
    units: { 'mg/g': identity, 'mg/mmol': scale(8.84, 'mg/mmol × 8.84') },
  },
  {
    id: 'body-weight',
    display: 'Body weight',
    unit: 'kg',
    precision: 1,
    members: [loinc('29463-7', 'Body weight'), loinc('3141-9', 'Body weight Measured')],
    units: {
      kg: identity,
      g: scale(0.001, 'g ÷ 1000'),
      '[lb_av]': scale(0.45359237, 'lb × 0.45359237'),
      '[oz_av]': scale(0.028349523125, 'oz × 0.0283495'),
    },
  },
  {
    id: 'body-height',
    display: 'Body height',
    unit: 'cm',
    precision: 1,
    members: [loinc('8302-2', 'Body height'), loinc('3137-7', 'Body height Measured'), loinc('8306-3', 'Body height --lying')],
    units: {
      cm: identity,
      m: scale(100, 'm × 100'),
      mm: scale(0.1, 'mm ÷ 10'),
      '[in_i]': scale(2.54, 'in × 2.54'),
      '[ft_i]': scale(30.48, 'ft × 30.48'),
    },
  },
  {
    id: 'bmi',
    display: 'Body mass index',
    unit: 'kg/m2',
    precision: 1,
    members: [loinc('39156-5', 'Body mass index (BMI) [Ratio]')],
    units: { 'kg/m2': identity },
  },
  {
    id: 'systolic-bp',
    display: 'Systolic blood pressure',
    unit: 'mm[Hg]',
    precision: 0,
    description: 'Matched as a standalone Observation or as a component of a blood pressure panel (85354-9, 55284-4).',
    members: [loinc('8480-6', 'Systolic blood pressure')],
    units: { 'mm[Hg]': identity, kPa: scale(7.50062, 'kPa × 7.50062') },
  },
  {
    id: 'diastolic-bp',
    display: 'Diastolic blood pressure',
    unit: 'mm[Hg]',
    precision: 0,
    description: 'Matched as a standalone Observation or as a component of a blood pressure panel (85354-9, 55284-4).',
    members: [loinc('8462-4', 'Diastolic blood pressure')],
    units: { 'mm[Hg]': identity, kPa: scale(7.50062, 'kPa × 7.50062') },
  },
  {
    id: 'heart-rate',
    display: 'Heart rate',
    unit: '/min',
    precision: 0,
    members: [loinc('8867-4', 'Heart rate')],
    units: { '/min': identity },
  },
  {
    id: 'respiratory-rate',
    display: 'Respiratory rate',
    unit: '/min',
    precision: 0,
    members: [loinc('9279-1', 'Respiratory rate')],
    units: { '/min': identity },
  },
  {
    id: 'body-temperature',
    display: 'Body temperature',
    unit: 'Cel',
    precision: 1,
    members: [loinc('8310-5', 'Body temperature')],
    units: {
      Cel: identity,
      '[degF]': { convert: (v) => ((v - 32) * 5) / 9, label: '(°F − 32) × 5/9' },
      K: { convert: (v) => v - 273.15, label: 'K − 273.15' },
    },
  },
  {
    id: 'oxygen-saturation',
    display: 'Oxygen saturation',
    unit: '%',
    precision: 0,
    members: [
      loinc('59408-5', 'Oxygen saturation in Arterial blood by Pulse oximetry'),
      loinc('2708-6', 'Oxygen saturation in Arterial blood'),
    ],
    units: { '%': identity, '1': scale(100, 'decimal fraction × 100') },
  },
];

const CONDITION_CONCEPTS = [
  {
    id: 'type-2-diabetes',
    display: 'Type 2 diabetes mellitus',
    members: [icd('E11')],
  },
  {
    id: 'type-1-diabetes',
    display: 'Type 1 diabetes mellitus',
    members: [icd('E10')],
  },
  {
    id: 'prediabetes',
    display: 'Prediabetes',
    members: [icd('R73.03', undefined, 'exact')],
  },
  {
    id: 'hypertension',
    display: 'Hypertensive diseases',
    description: 'ICD-10-CM block I10-I16: essential, secondary and hypertensive heart/kidney disease, and hypertensive crisis.',
    members: [icd('I10'), icd('I11'), icd('I12'), icd('I13'), icd('I15'), icd('I16')],
  },
  {
    id: 'hyperlipidemia',
    display: 'Hyperlipidemia',
    description: 'E78.0-E78.5. The rest of E78 is not hyperlipidemia (E78.6 is lipoprotein deficiency).',
    members: [icd('E78.0'), icd('E78.1'), icd('E78.2'), icd('E78.3'), icd('E78.4'), icd('E78.5')],
    excluded: [exclude(icd('E78.6'), 'Lipoprotein deficiency: too little, not too much')],
  },
  {
    id: 'chronic-kidney-disease',
    display: 'Chronic kidney disease',
    members: [icd('N18')],
  },
  {
    id: 'asthma',
    display: 'Asthma',
    members: [icd('J45')],
  },
  {
    id: 'copd',
    display: 'Chronic obstructive pulmonary disease',
    members: [icd('J44'), icd('J43', 'Emphysema')],
  },
  {
    id: 'heart-failure',
    display: 'Heart failure',
    description: 'I50, plus the hypertensive heart disease codes that include heart failure.',
    members: [
      icd('I50'),
      icd('I11.0', 'Hypertensive heart disease with heart failure', 'exact'),
      icd('I13.0', 'Hypertensive heart and CKD with heart failure, stage 1-4 CKD', 'exact'),
      icd('I13.2', 'Hypertensive heart and CKD with heart failure, stage 5/ESRD', 'exact'),
    ],
  },
  {
    id: 'atrial-fibrillation',
    display: 'Atrial fibrillation',
    description: 'Fibrillation codes only; I48 also contains atrial flutter.',
    members: [icd('I48.0'), icd('I48.1'), icd('I48.2'), icd('I48.91', undefined, 'exact')],
    excluded: [
      exclude(icd('I48.3', undefined, 'exact'), 'Atrial flutter, not fibrillation'),
      exclude(icd('I48.4', undefined, 'exact'), 'Atrial flutter, not fibrillation'),
      exclude(icd('I48.92', undefined, 'exact'), 'Atrial flutter, not fibrillation'),
    ],
  },
  {
    id: 'ischemic-heart-disease',
    display: 'Chronic ischemic heart disease',
    members: [icd('I25')],
  },
  {
    id: 'depression',
    display: 'Major depressive disorder',
    members: [icd('F32'), icd('F33')],
  },
  {
    id: 'obesity',
    display: 'Obesity',
    description: 'E66 except E66.3, which is overweight.',
    members: [icd('E66.0'), icd('E66.1'), icd('E66.2'), icd('E66.8'), icd('E66.9')],
    excluded: [exclude(icd('E66.3', undefined, 'exact'), 'Overweight, not obesity')],
  },
  {
    id: 'dementia',
    display: "Dementia, including Alzheimer's disease",
    members: [icd('F01'), icd('F02'), icd('F03'), icd('G30', "Alzheimer's disease")],
  },
  {
    id: 'hypothyroidism',
    display: 'Hypothyroidism',
    members: [icd('E03')],
  },
];

export const CONCEPTS = [
  ...OBSERVATION_CONCEPTS.map((c) => ({ ...c, domain: 'observation' })),
  ...CONDITION_CONCEPTS.map((c) => ({ ...c, domain: 'condition' })),
];

const BY_ID = new Map(CONCEPTS.map((c) => [c.id, c]));
const EXACT = new Map(); // 'system|code' -> [{ concept, member }]
const ROOTS = []; // descendant members

for (const concept of CONCEPTS) {
  for (const member of concept.members) {
    if (member.match === 'descendants') ROOTS.push({ concept, member });
    else {
      const key = `${member.system}|${member.code}`;
      EXACT.set(key, [...(EXACT.get(key) ?? []), { concept, member }]);
    }
  }
}

export function getConcept(id) {
  return BY_ID.get(id) ?? null;
}

/** An ICD-10-CM code is under a root if it is the root or one of its subcodes. */
export function isUnderRoot(code, root) {
  if (code === root) return true;
  // 'E11' covers 'E11.9' but must not cover some unrelated 'E110'; 'E78.0' covers 'E78.01'.
  return root.includes('.') ? code.startsWith(root) : code.startsWith(`${root}.`);
}

/**
 * Concepts a canonical (system, code) pair belongs to. Callers normalize first
 * (normalizeCoding), so aliases and undotted ICD codes resolve here too.
 */
export function conceptsFor(system, code) {
  if (!system || !code) return [];
  const matches = [...(EXACT.get(`${system}|${code}`) ?? [])];
  for (const { concept, member } of ROOTS) {
    if (member.system === system && isUnderRoot(code, member.code)) matches.push({ concept, member });
  }
  return matches;
}

/** Concepts that deliberately exclude this code, with the reason. */
export function exclusionsFor(system, code) {
  return CONCEPTS.flatMap((concept) =>
    (concept.excluded ?? [])
      .filter((ex) => ex.system === system && (ex.match === 'descendants' ? isUnderRoot(code, ex.code) : ex.code === code))
      .map((ex) => ({ concept: concept.id, reason: ex.reason })),
  );
}

/** Exact member codes of a concept (what a GIN containment pre-filter can use). */
export function exactCodes(concept) {
  return concept.members.filter((m) => m.match === 'exact').map((m) => m.code);
}
