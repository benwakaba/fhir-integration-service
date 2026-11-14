// Remembered dismissals. A steward's "these are different people" is stored as pairs of
// SOURCE records (the dismissed_pairs table), not as golden ids: `npm run mpi:rebuild`
// regenerates every golden id, and source records are what survive it. A decision is
// about people, so it is recorded for every pair of records the two patients hold, and
// read back through wherever those records are linked now.
//
// Everything here runs in the caller's transaction, under the MPI lock.

/**
 * Remember that the patients in each [x, y] pair are different people: one row for
 * every pair of their source records. `via` says how the steward decided ('pair' or
 * 'group'). Deciding again overwrites the earlier time, since the latest decision wins.
 * Returns how many record pairs were stored.
 */
export async function rememberDismissals(client, patientPairs, via) {
  if (!patientPairs.length) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO dismissed_pairs (record_a, record_b, via)
     SELECT DISTINCT LEAST(a.resource_id, b.resource_id), GREATEST(a.resource_id, b.resource_id), $3::text
     FROM unnest($1::uuid[], $2::uuid[]) AS p(x, y)
     JOIN patient_links a ON a.master_id = p.x
     JOIN patient_links b ON b.master_id = p.y
     WHERE a.resource_id <> b.resource_id
     ON CONFLICT (record_a, record_b) DO UPDATE SET via = EXCLUDED.via, dismissed_at = now()`,
    [patientPairs.map(([x]) => x), patientPairs.map(([, y]) => y), via],
  );
  return rowCount;
}

/**
 * The patients holding a record that a steward dismissed against this source record,
 * for matching a record that has no patient yet. A partner record that has not been
 * linked (during a rebuild, one that comes later) has no patient and so is not here.
 */
export async function dismissedAgainstRecord(db, resourceId) {
  const { rows } = await db.query(
    `SELECT pl.master_id
     FROM dismissed_pairs d JOIN patient_links pl ON pl.resource_id = d.record_b
     WHERE d.record_a = $1
     UNION
     SELECT pl.master_id
     FROM dismissed_pairs d JOIN patient_links pl ON pl.resource_id = d.record_a
     WHERE d.record_b = $1`,
    [resourceId],
  );
  return new Set(rows.map((r) => r.master_id));
}

/**
 * The patients a steward has dismissed against this patient: where the partners of
 * any of its records are now. This is the question to ask once a new record has
 * landed in a patient, because the steward's decision was about the person, however
 * many records they have since gained.
 */
export async function dismissedAgainstPatient(db, masterId) {
  const { rows } = await db.query(
    `SELECT other.master_id
     FROM patient_links mine
     JOIN dismissed_pairs d ON d.record_a = mine.resource_id
     JOIN patient_links other ON other.resource_id = d.record_b
     WHERE mine.master_id = $1 AND other.master_id <> $1
     UNION
     SELECT other.master_id
     FROM patient_links mine
     JOIN dismissed_pairs d ON d.record_b = mine.resource_id
     JOIN patient_links other ON other.resource_id = d.record_a
     WHERE mine.master_id = $1 AND other.master_id <> $1`,
    [masterId],
  );
  return new Set(rows.map((r) => r.master_id));
}

/**
 * A steward just decided that every record this patient holds is one person, so
 * a dismissal between two of them is contradicted: the latest decision wins. Dismissals
 * between this patient and anyone else stand. Returns how many record pairs went.
 */
export async function forgetDismissalsWithin(client, masterId) {
  const { rowCount } = await client.query(
    `DELETE FROM dismissed_pairs d
     USING patient_links a, patient_links b
     WHERE a.resource_id = d.record_a AND b.resource_id = d.record_b
       AND a.master_id = $1 AND b.master_id = $1`,
    [masterId],
  );
  return rowCount;
}

/** Who a patient has been dismissed against, newest first: [{ patient, since, via }]. */
export async function dismissedPartners(db, masterId) {
  const { rows } = await db.query(
    `SELECT patient, max(dismissed_at) AS since, (array_agg(via ORDER BY dismissed_at DESC))[1] AS via
     FROM (
       SELECT other.master_id AS patient, d.dismissed_at, d.via
       FROM patient_links mine
       JOIN dismissed_pairs d ON d.record_a = mine.resource_id
       JOIN patient_links other ON other.resource_id = d.record_b
       WHERE mine.master_id = $1 AND other.master_id <> $1
       UNION ALL
       SELECT other.master_id, d.dismissed_at, d.via
       FROM patient_links mine
       JOIN dismissed_pairs d ON d.record_b = mine.resource_id
       JOIN patient_links other ON other.resource_id = d.record_a
       WHERE mine.master_id = $1 AND other.master_id <> $1
     ) pairs
     GROUP BY patient
     ORDER BY since DESC, patient`,
    [masterId],
  );
  return rows;
}

/**
 * How many dismissals the table holds, as pairs of patients and as pairs of records
 * (both records of a pair linked, to different patients). For the rebuild's report.
 */
export async function countDismissals(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS records,
            count(DISTINCT (LEAST(a.master_id, b.master_id), GREATEST(a.master_id, b.master_id)))::int AS patients
     FROM dismissed_pairs d
     JOIN patient_links a ON a.resource_id = d.record_a
     JOIN patient_links b ON b.resource_id = d.record_b
     WHERE a.master_id <> b.master_id`,
  );
  return rows[0];
}
