// Rebuild the master patient index from the stored source Patients, e.g. after
// changing matching rules. Golden record ids are regenerated, and steward work
// (overrides, manual links) would be lost, so the script refuses to run while
// any exists unless --force is given.
//
//   npm run mpi:rebuild [-- --force]

import { parseArgs } from 'node:util';
import pool, { withTransaction } from '../src/db/pool.js';
import { onPatientChanged } from '../src/mpi/index.js';

const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } });

try {
  const { rows: steward } = await pool.query(
    `SELECT (SELECT count(*) FROM master_patients WHERE overrides <> '{}')::int AS overrides,
            (SELECT count(*) FROM patient_links WHERE method = 'manual')::int AS manual`,
  );
  if ((steward[0].overrides || steward[0].manual) && !values.force) {
    throw new Error(`${steward[0].overrides} override(s) and ${steward[0].manual} manual link(s) would be lost; re-run with --force`);
  }
  await pool.query('TRUNCATE patient_links, master_patient_versions, master_patients');
  let lastId = 0;
  let linked = 0;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT * FROM resources WHERE resource_type = 'Patient' AND NOT deleted AND id > $1 ORDER BY id LIMIT 200`,
      [lastId],
    );
    if (!rows.length) break;
    await withTransaction(async (client) => {
      for (const row of rows) await onPatientChanged(client, row);
    });
    linked += rows.length;
    lastId = rows.at(-1).id;
  }
  const { rows } = await pool.query(
    `SELECT count(*)::int AS masters, count(*) FILTER (WHERE needs_review)::int AS review FROM master_patients`,
  );
  console.log(`Linked ${linked} source Patients into ${rows[0].masters} patients (${rows[0].review} need review).`);
} catch (err) {
  console.error(`Rebuild failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
