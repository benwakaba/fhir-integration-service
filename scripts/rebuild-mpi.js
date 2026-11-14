// Rebuild the master patient index from the stored source Patients, e.g. after
// changing matching rules. Golden record ids are regenerated, so steward work on
// golden records (overrides, manual links, confirmed merges) would be lost, and the
// script refuses to run while any exists unless --force is given.
//
// Dismissals ("these are different people") are kept: they are stored against source
// records, so the candidates a steward dismissed are not raised again. Pass
// --forget-dismissals to drop them too and start the review queue from scratch.
//
//   npm run mpi:rebuild                                  keeps dismissals
//   npm run mpi:rebuild -- --forget-dismissals           starts the review queue from scratch
//   npm run mpi:rebuild -- --force                       also loses overrides and manual links

import { parseArgs } from 'node:util';
import pool from '../src/db/pool.js';
import { rebuildMpi } from '../src/mpi/rebuild.js';

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
    'forget-dismissals': { type: 'boolean', default: false },
  },
});

const describe = ({ patients, records }) => `${patients} dismissed pair${patients === 1 ? '' : 's'} of patients (${records} record pairs)`;

try {
  const result = await rebuildMpi({ force: values.force, forgetDismissals: values['forget-dismissals'] });
  console.log(`Linked ${result.linked} source Patients into ${result.patients} patients (${result.needReview} need review).`);
  if (result.keptDismissals?.records) console.log(`Kept ${describe(result.keptDismissals)}; they were not raised again.`);
  if (result.forgottenDismissals?.records) console.log(`Forgot ${describe(result.forgottenDismissals)}; the review queue starts from scratch.`);
} catch (err) {
  console.error(`Rebuild failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
