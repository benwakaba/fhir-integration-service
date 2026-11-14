// Loads an ICD-10-CM release from the CMS / CDC NCHS files
// (https://www.cms.gov/medicare/coding-billing/icd-10-codes, "Code Descriptions in
// Tabular Order"). Either file works:
//   icd10cm_order_YYYY.txt  fixed width; includes non-billable category headers
//                           (E11, C92.0), which lets validation tell a header
//                           code from a codable diagnosis. Preferred.
//   icd10cm_codes_YYYY.txt  billable codes only
// Codes are stored in the dotted form FHIR uses (E11.9), not the file's E119.

import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { ICD10CM } from '../systems.js';
import { replaceSystem } from './loinc.js';

// Order file layout: order number (1-5), code (7-13, no dot), header flag (15:
// 1 = valid for HIPAA-covered transactions, 0 = header), short description
// (17-76), long description (78-).
const ORDER_LINE = /^\d{5} [A-Z0-9 ]{7} [01] /;

export async function loadIcd10cm({ file, version }) {
  const rows = [];
  let format = null;
  for await (const line of readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    format ??= ORDER_LINE.test(line) ? 'order' : 'codes';
    if (format === 'order') {
      const code = line.slice(6, 13).trim();
      const billable = line[14] === '1';
      rows.push({
        code: dotted(code),
        display: line.slice(77).trim() || line.slice(16, 76).trim(),
        status: billable ? 'active' : 'header',
        properties: { billable, shortDescription: line.slice(16, 76).trim() },
      });
    } else {
      const match = /^(\S+)\s+(.+)$/.exec(line);
      if (!match) throw new Error(`Unrecognized line in ${file}: ${line.slice(0, 60)}`);
      rows.push({ code: dotted(match[1]), display: match[2].trim(), status: 'active', properties: { billable: true } });
    }
  }
  const release = version ?? /icd10cm_(?:order|codes)_(\d{4})/i.exec(file)?.[1] ?? null;
  await replaceSystem(ICD10CM, 'ICD-10-CM', release ? `FY${release}` : null, file, rows, ['codes']);
  return { system: ICD10CM, version: release ? `FY${release}` : null, codes: rows.length, format, headers: rows.filter((r) => r.status === 'header').length };
}

function dotted(code) {
  return code.length > 3 ? `${code.slice(0, 3)}.${code.slice(3)}` : code;
}
