const pool = require('../db/pool');

async function createPrescriptionRequest({
  gupshupMessageId,
  secondaryGupshupMessageId,
  tertiaryGupshupMessageId,
  quaternaryGupshupMessageId,
  customerName,
  customerPhone,
  method,
  fileUrl,
  products,
  shopifyOrderId,
  shopifyOrderGid,
}) {
  const result = await pool.query(
    `INSERT INTO prescription_requests
       (gupshup_message_id, secondary_gupshup_message_id, tertiary_gupshup_message_id, quaternary_gupshup_message_id, customer_name, customer_phone, method, file_url, products, shopify_order_id, shopify_order_gid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      gupshupMessageId,
      secondaryGupshupMessageId || null,
      tertiaryGupshupMessageId || null,
      quaternaryGupshupMessageId || null,
      customerName,
      customerPhone,
      method,
      fileUrl || null,
      JSON.stringify(products || []),
      shopifyOrderId || null,
      shopifyOrderGid || null,
    ],
  );
  return result.rows[0].id;
}

// Matches on the primary, secondary, or tertiary send's messageId, since all
// configured doctors get the request at the same time and any of them may
// reply first. The status = 'pending' guard makes the first reply win — once
// one doctor has responded, a later reply from another number is a no-op
// rather than silently overwriting an already-notified decision.
async function updateStatusByMessageId(gupshupMessageId, status) {
  const result = await pool.query(
    `UPDATE prescription_requests
     SET status = $2, responded_at = now()
     WHERE (gupshup_message_id = $1 OR secondary_gupshup_message_id = $1 OR tertiary_gupshup_message_id = $1 OR quaternary_gupshup_message_id = $1)
       AND status = 'pending'
     RETURNING id, customer_phone, customer_name, products, gupshup_message_id, secondary_gupshup_message_id, tertiary_gupshup_message_id, quaternary_gupshup_message_id, shopify_order_gid`,
    [gupshupMessageId, status],
  );
  return result.rows[0] || null;
}

// Used only when updateStatusByMessageId finds no pending row to update, to
// tell apart "already resolved by another doctor" (row exists) from a truly
// unrecognized message id (row doesn't exist) for logging purposes.
async function findByMessageId(gupshupMessageId) {
  const result = await pool.query(
    `SELECT id, status FROM prescription_requests
     WHERE gupshup_message_id = $1 OR secondary_gupshup_message_id = $1 OR tertiary_gupshup_message_id = $1 OR quaternary_gupshup_message_id = $1`,
    [gupshupMessageId],
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
  updateStatusByMessageId,
  findByMessageId,
  findRecentByPhone,
  existsByShopifyOrderId,
};
