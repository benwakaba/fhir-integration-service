# Test fixtures

`terminology/` holds a few rows in the exact layouts of the official releases, so
the loaders are tested against real formats without shipping the releases:

- `icd10cm_order_2026.txt` - CMS "tabular order" file: fixed width, with the
  header flag in column 15 (0 = category header, 1 = billable). Order numbers are
  sequential here, not the release's.
- `icd10cm_codes_2026.txt` - the billable-only codes file.
- `Loinc.csv` - a subset of LoincTable/Loinc.csv columns. Loaders find columns by
  header name, so the subset exercises the same code path.
- `AnswerList.csv`, `Part.csv` - rows copied from LOINC 2.83's AccessoryFiles. The
  answer file's `ExtCode*` columns (SNOMED CT mappings) are blanked: SNOMED content is
  not redistributed here, and the loader does not read them.

ICD-10-CM is a US government work in the public domain. This material contains
content from LOINC (http://loinc.org), copyright Regenstrief Institute, Inc. and the
LOINC Committee, available at no cost under the license at http://loinc.org/license.
