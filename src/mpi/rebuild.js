// Rebuild the master patient index from the stored source Patients, e.g. after changing
// matching rules. Golden record ids are regenerated, so everything a steward did on
// golden records (overrides, manual links, confirmed merges) would be lost, and the
// rebuild refuses to run while any exists unless `force` is given.
//
// Dismissals ("these are different people") are the exception: they are stored against
// source records, which a rebuild leaves alone, so the candidates a steward dismissed
// are not raised again. `forgetDismissals` drops them as well, to start the review
// queue from scratch.

import pool, { withTransaction } from '../db/pool.js';
import { countDismissals } from './dismissals.js';
import { onPatientChanged } from './index.js';

/**
 * Returns { linked, patients, needReview, keptDismissals, forgottenDismissals }; the last
 * two are { patients, records } counts or null.
 */
export async function rebuildMpi({ force = false, forgetDismissals = false } = {}) {
  const { rows: steward } = await pool.query(
    `SELECT (SELECT count(*) FROM master_patients WHERE overrides <> '{}')::int AS overrides,
            (SELECT count(*) FROM patient_links WHERE method = 'manual')::int AS manual`,
  );
  if ((steward[0].overrides || steward[0].manual) && !force) {
    throw new Error(`${steward[0].overrides} override(s) and ${steward[0].manual} manual link(s) would be lost; re-run with --force`);
  }

  // Counted before the truncate: afterwards the table is empty, and the patients are new.
  const forgottenDismissals = forgetDismissals ? await countDismissals(pool) : null;
  await pool.query(`TRUNCATE patient_links, master_patient_versions, master_patients${forgetDismissals ? ', dismissed_pairs' : ''}`);

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
    `SELECT count(*)::int AS patients, count(*) FILTER (WHERE needs_review)::int AS review FROM master_patients`,
  );
  return {
    linked,
    patients: rows[0].patients,
    needReview: rows[0].review,
    keptDismissals: forgetDismissals ? null : await countDismissals(pool),
    forgottenDismissals,
  };
}
