CREATE TABLE IF NOT EXISTS prescription_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Gupshup's messageId for the template send — the join key used to match
  -- an incoming Approve/Reject webhook reply back to this request.
  gupshup_message_id TEXT UNIQUE,

  -- Gupshup's messageId for the send to the secondary/tertiary doctor
  -- numbers, sent at the same time as gupshup_message_id (null if that
  -- number isn't configured). Also a valid join key for an incoming
  -- Approve/Reject webhook reply.
  secondary_gupshup_message_id TEXT UNIQUE,
  tertiary_gupshup_message_id TEXT UNIQUE,
  quaternary_gupshup_message_id TEXT UNIQUE,

  customer_name      TEXT NOT NULL,
  customer_phone     TEXT NOT NULL,

  -- Which cart-drawer option the customer chose.
  method             TEXT NOT NULL CHECK (method IN ('consult', 'upload')),

  -- S3 URL of the uploaded prescription photo/PDF; null when method = consult.
  file_url           TEXT,

  -- Cart items requiring a prescription, as sent from the storefront:
  -- [{"product_id": 123, "title": "...", "quantity": 2}, ...]
  products           JSONB NOT NULL DEFAULT '[]',

  -- Same product/medicine summary text sent to the doctors in the WhatsApp
  -- template's content variables (see summarizeProducts) — captured here too
  -- so it doesn't have to be recomputed from `products` for display.
  medicine_name      TEXT,

  -- Which configured doctor slot (env config, not a foreign key) actually
  -- resolved this request via Approve/Reject — snapshotted the moment their
  -- reply comes in, since a doctor's name/number could change in config
  -- later. NOT the prescribing doctor from the photo (no pharmacist-review
  -- flow exists to transcribe that).
  doctor_name        TEXT,
  doctor_mobile      TEXT,

  -- Populated once the order is actually placed, to link this approval back
  -- to order fulfillment.
  shopify_order_id   TEXT,

  -- Order's Admin GraphQL GID (e.g. "gid://shopify/Order/123"), captured
  -- alongside shopify_order_id so an Approve/Reject decision can call back
  -- into the Shopify Admin API (metafield clear, line-item cancel) without a
  -- separate lookup. Null for any request created before this column existed.
  shopify_order_gid  TEXT,

  -- pending_<slot> tracks which doctor is currently holding the request in
  -- the Primary -> Secondary -> Tertiary -> Quaternary sequential chain (see
  -- doctorApprovalFlow.service.js); 'failed' means every configured doctor
  -- timed out with no reply. approved/rejected double as "completed" too —
  -- the Shopify/WhatsApp side effects that follow a decision run inline,
  -- synchronously, so there's never a real gap between "decided" and "done"
  -- worth its own status.
  status             TEXT NOT NULL DEFAULT 'pending_primary'
                       CHECK (status IN ('pending_primary', 'pending_secondary', 'pending_tertiary', 'pending_quaternary', 'approved', 'rejected', 'failed', 'pending')),
  pharmacist_notes    TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_prescription_requests_customer_phone
  ON prescription_requests (customer_phone);

CREATE INDEX IF NOT EXISTS idx_prescription_requests_status
  ON prescription_requests (status);

-- One row per doctor per attempt in the sequential Primary -> Secondary ->
-- Tertiary -> Quaternary approval chain — the complete audit trail of who
-- was asked, when, and what happened. `outcome`:
--   awaiting    sent, 60s timer running
--   responded   this reply is the one that resolved the request
--   expired     60s elapsed with no reply, chain moved to the next doctor
--   superseded  doctor replied, but too late — someone else already resolved it
--   send_failed the WhatsApp send itself never went out
CREATE TABLE IF NOT EXISTS doctor_request_log (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_request_id  UUID NOT NULL REFERENCES prescription_requests(id),
  doctor_slot               TEXT NOT NULL CHECK (doctor_slot IN ('primary', 'secondary', 'tertiary', 'quaternary')),
  doctor_name                TEXT,
  doctor_mobile              TEXT,
  gupshup_message_id         TEXT UNIQUE,
  sent_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at                TIMESTAMPTZ,
  response                    TEXT CHECK (response IN ('approved', 'rejected')),
  outcome                     TEXT NOT NULL DEFAULT 'awaiting'
                               CHECK (outcome IN ('awaiting', 'responded', 'expired', 'superseded', 'send_failed')),
  error_detail                TEXT
);

CREATE INDEX IF NOT EXISTS idx_doctor_request_log_request ON doctor_request_log (prescription_request_id);

-- Bridges the cart-drawer's immediate S3 upload (while still on zigly.com)
-- to the orders/create webhook (which has no concept of an uploaded file at
-- all). The cart-drawer tags the Shopify cart with this row's key as a cart
-- attribute, which Shopify carries through into the order's note_attributes;
-- the webhook looks it up and deletes it once consumed.
CREATE TABLE IF NOT EXISTS pending_prescription_uploads (
  key        TEXT PRIMARY KEY,
  file_url   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No migration runner in this project — for a prescription_requests table
-- that already existed before the secondary-doctor feature, run these
-- statements by hand against it.
ALTER TABLE prescription_requests ADD COLUMN IF NOT EXISTS secondary_gupshup_message_id TEXT UNIQUE;
ALTER TABLE prescription_requests ADD COLUMN IF NOT EXISTS tertiary_gupshup_message_id TEXT UNIQUE;
ALTER TABLE prescription_requests ADD COLUMN IF NOT EXISTS quaternary_gupshup_message_id TEXT UNIQUE;

-- Added for the Rx order-hold Approve/Reject Shopify actions (metafield
-- clear, line-item cancel) — see docs/unicommerce-prescription-hold.md.
ALTER TABLE prescription_requests ADD COLUMN IF NOT EXISTS shopify_order_gid TEXT;

-- escalated_at was used by an even older "wait 2 min, then notify secondary"
-- flow, superseded by notifying all doctors at once — dropped it then.
ALTER TABLE prescription_requests DROP COLUMN IF EXISTS escalated_at;

-- Sequential Primary -> Secondary -> Tertiary -> Quaternary approval chain:
-- widen the status values and audit every attempt in doctor_request_log
-- instead of the old "one shared status, four message-id columns" model.
-- Existing rows are left as 'pending'/'approved'/'rejected' — nothing
-- re-reads the old gupshup_message_id/secondary/tertiary/quaternary columns
-- for new requests going forward, but they're kept (not dropped) so
-- historical rows stay queryable as they were.
ALTER TABLE prescription_requests DROP CONSTRAINT IF EXISTS prescription_requests_status_check;
ALTER TABLE prescription_requests ADD CONSTRAINT prescription_requests_status_check
  CHECK (status IN ('pending_primary', 'pending_secondary', 'pending_tertiary', 'pending_quaternary', 'approved', 'rejected', 'failed', 'pending'));
ALTER TABLE prescription_requests ALTER COLUMN status SET DEFAULT 'pending_primary';
