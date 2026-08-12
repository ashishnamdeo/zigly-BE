const pool = require('../db/pool');

async function createPrescriptionRequest({
  customerName,
  customerPhone,
  method,
  fileUrl,
  products,
  medicineName,
  shopifyOrderId,
  shopifyOrderGid,
  status = 'pending_primary',
}) {
  const result = await pool.query(
    `INSERT INTO prescription_requests
       (customer_name, customer_phone, method, file_url, products, medicine_name, shopify_order_id, shopify_order_gid, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      customerName,
      customerPhone,
      method,
      fileUrl || null,
      JSON.stringify(products || []),
      medicineName || null,
      shopifyOrderId || null,
      shopifyOrderGid || null,
      status,
    ],
  );
  return result.rows[0].id;
}

async function getRequestById(id) {
  const result = await pool.query(
    `SELECT id, status, customer_name, customer_phone, method, file_url, products,
            medicine_name, doctor_name, doctor_mobile, shopify_order_gid, responded_at
     FROM prescription_requests WHERE id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

// The single guard the whole sequential flow rests on: only succeeds if the
// request is still exactly where the caller expects (fromStatus). A doctor's
// reply and the escalation timer both call this with the same shape of
// query — Postgres's row lock, not application code, decides who wins a true
// tie; the loser's call affects 0 rows and is a safe no-op for the caller to
// check via the return value.
async function transitionRequestStatus(id, fromStatus, toStatus, { doctorName, doctorMobile } = {}) {
  const setDoctor = doctorName !== undefined || doctorMobile !== undefined;
  const result = await pool.query(
    setDoctor
      ? `UPDATE prescription_requests
         SET status = $2, responded_at = now(), doctor_name = $3, doctor_mobile = $4
         WHERE id = $1 AND status = $5
         RETURNING id, status, customer_name, customer_phone, method, file_url, products, doctor_name, doctor_mobile, shopify_order_gid`
      : `UPDATE prescription_requests
         SET status = $2
         WHERE id = $1 AND status = $3
         RETURNING id, status, customer_name, customer_phone, method, file_url, products, doctor_name, doctor_mobile, shopify_order_gid`,
    setDoctor ? [id, toStatus, doctorName || null, doctorMobile || null, fromStatus] : [id, toStatus, fromStatus],
  );
  return result.rows[0] || null;
}

async function insertDoctorRequestLog({ prescriptionRequestId, doctorSlot, doctorName, doctorMobile, gupshupMessageId }) {
  const result = await pool.query(
    `INSERT INTO doctor_request_log (prescription_request_id, doctor_slot, doctor_name, doctor_mobile, gupshup_message_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [prescriptionRequestId, doctorSlot, doctorName || null, doctorMobile || null, gupshupMessageId || null],
  );
  return result.rows[0].id;
}

async function markDoctorLogSendFailed(logId, errorDetail) {
  await pool.query(`UPDATE doctor_request_log SET outcome = 'send_failed', error_detail = $2 WHERE id = $1`, [
    logId,
    errorDetail || null,
  ]);
}

async function markDoctorLogResponded(logId, response) {
  await pool.query(
    `UPDATE doctor_request_log SET outcome = 'responded', responded_at = now(), response = $2 WHERE id = $1`,
    [logId, response],
  );
}

// Guarded on outcome != 'superseded' so a duplicate delivery of an
// already-late reply (Gupshup redelivering the same webhook) updates 0 rows
// the second time — the caller uses that to decide whether to re-notify the
// doctor (first time) or silently no-op (duplicate).
async function markDoctorLogSuperseded(logId, response) {
  const result = await pool.query(
    `UPDATE doctor_request_log SET outcome = 'superseded', responded_at = now(), response = $2
     WHERE id = $1 AND outcome != 'superseded'
     RETURNING id`,
    [logId, response],
  );
  return result.rows.length > 0;
}

async function markDoctorLogExpired(logId) {
  await pool.query(`UPDATE doctor_request_log SET outcome = 'expired' WHERE id = $1 AND outcome = 'awaiting'`, [logId]);
}

// The one lookup an incoming Approve/Reject webhook reply needs: which
// request, which slot, whether this attempt is still awaiting a reply, and
// the parent request's current status/customer/doctor info in one round trip.
async function findDoctorLogByMessageId(gupshupMessageId) {
  const result = await pool.query(
    `SELECT l.id AS log_id, l.doctor_slot, l.outcome, l.prescription_request_id,
            r.status AS request_status, r.customer_name, r.customer_phone, r.products,
            r.doctor_name, r.doctor_mobile, r.shopify_order_gid
     FROM doctor_request_log l
     JOIN prescription_requests r ON r.id = l.prescription_request_id
     WHERE l.gupshup_message_id = $1`,
    [gupshupMessageId],
  );
  return result.rows[0] || null;
}

// At most one row can ever be 'awaiting' for a given request+slot (each slot
// is only ever paged once) — used by the escalation checker to mark that
// attempt 'expired' once its 60s window has passed with no reply.
async function findAwaitingDoctorLog(prescriptionRequestId, doctorSlot) {
  const result = await pool.query(
    `SELECT id FROM doctor_request_log WHERE prescription_request_id = $1 AND doctor_slot = $2 AND outcome = 'awaiting' LIMIT 1`,
    [prescriptionRequestId, doctorSlot],
  );
  return result.rows[0] || null;
}

// Matches on the last 10 digits on both sides since customer_phone is stored
// as typed (may or may not carry a country code) while Shopify's order phone
// fields typically do carry one (e.g. "+91...").
async function findRecentByPhone(phone, { limit = 50 } = {}) {
  const result = await pool.query(
    `SELECT products, status, created_at, responded_at
     FROM prescription_requests
     WHERE right(regexp_replace(customer_phone, '\\D', '', 'g'), 10)
         = right(regexp_replace($1, '\\D', '', 'g'), 10)
       AND created_at > now() - interval '90 days'
     ORDER BY created_at DESC
     LIMIT $2`,
    [phone, limit],
  );
  return result.rows;
}

// Shopify delivers webhooks at-least-once, so the same orders/create event
// can arrive more than once — check this before creating a request so a
// retried delivery doesn't send a duplicate WhatsApp message.
async function existsByShopifyOrderId(shopifyOrderId) {
  const result = await pool.query(
    `SELECT id FROM prescription_requests WHERE shopify_order_id = $1 LIMIT 1`,
    [shopifyOrderId],
  );
  return result.rows.length > 0;
}

module.exports = {
  createPrescriptionRequest,
  getRequestById,
  transitionRequestStatus,
  insertDoctorRequestLog,
  markDoctorLogSendFailed,
  markDoctorLogResponded,
  markDoctorLogSuperseded,
  markDoctorLogExpired,
  findDoctorLogByMessageId,
  findAwaitingDoctorLog,
  findRecentByPhone,
  existsByShopifyOrderId,
};
