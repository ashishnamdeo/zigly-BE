CREATE TABLE IF NOT EXISTS prescription_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Gupshup's messageId for the template send — the join key used to match
  -- an incoming Approve/Reject webhook reply back to this request.
  gupshup_message_id TEXT UNIQUE,

  customer_name      TEXT NOT NULL,
  customer_phone     TEXT NOT NULL,

  -- Which cart-drawer option the customer chose.
  method             TEXT NOT NULL CHECK (method IN ('consult', 'upload')),

  -- S3 URL of the uploaded prescription photo/PDF; null when method = consult.
  file_url           TEXT,

  -- Cart items requiring a prescription, as sent from the storefront:
  -- [{"product_id": 123, "title": "...", "quantity": 2}, ...]
  products           JSONB NOT NULL DEFAULT '[]',

  -- Medicine name(s) as written on the prescription itself (may differ from
  -- the ordered product) — filled in by the pharmacist during review.
  medicine_name      TEXT,

  -- Prescribing doctor's details, transcribed from the prescription during
  -- pharmacist review (or captured directly if the consult flow collects it).
  doctor_name        TEXT,
  doctor_mobile      TEXT,

  -- Populated once the order is actually placed, to link this approval back
  -- to order fulfillment.
  shopify_order_id   TEXT,

  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected')),
  pharmacist_notes    TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_prescription_requests_customer_phone
  ON prescription_requests (customer_phone);

CREATE INDEX IF NOT EXISTS idx_prescription_requests_status
  ON prescription_requests (status);
