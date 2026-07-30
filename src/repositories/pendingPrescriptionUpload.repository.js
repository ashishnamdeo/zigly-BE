const pool = require('../db/pool');

// No migration runner in this project (see db/schema.sql) — this table is
// small and self-contained enough to create on first use instead.
const ENSURE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS pending_prescription_uploads (
    key        TEXT PRIMARY KEY,
    file_url   TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;
let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await pool.query(ENSURE_TABLE_SQL);
  tableEnsured = true;
}

async function createPendingUpload({ key, fileUrl }) {
  await ensureTable();
  await pool.query(
    `INSERT INTO pending_prescription_uploads (key, file_url) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET file_url = EXCLUDED.file_url`,
    [key, fileUrl],
  );
}

// Deletes on read so a key can't be reused across orders and stale rows
// don't accumulate — returns null if the key is unknown/already consumed.
async function consumePendingUpload(key) {
  await ensureTable();
  const result = await pool.query(
    `DELETE FROM pending_prescription_uploads WHERE key = $1 RETURNING file_url`,
    [key],
  );
  return result.rows[0]?.file_url || null;
}

module.exports = { createPendingUpload, consumePendingUpload };
