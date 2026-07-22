const pool = require('../db/pool');

async function createPrescriptionRequest({
  gupshupMessageId,
  customerName,
  customerPhone,
  method,
  fileUrl,
  products,
}) {
  const result = await pool.query(
    `INSERT INTO prescription_requests
       (gupshup_message_id, customer_name, customer_phone, method, file_url, products)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [gupshupMessageId, customerName, customerPhone, method, fileUrl || null, JSON.stringify(products || [])],
  );
  return result.rows[0].id;
}

async function updateStatusByMessageId(gupshupMessageId, status) {
  const result = await pool.query(
    `UPDATE prescription_requests
     SET status = $2, responded_at = now()
     WHERE gupshup_message_id = $1
     RETURNING id`,
    [gupshupMessageId, status],
  );
  return result.rows[0] || null;
}

module.exports = { createPrescriptionRequest, updateStatusByMessageId };
