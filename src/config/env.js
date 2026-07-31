require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  gupshup: {
    apiKey: process.env.GUPSHUP_API_KEY,
    // The WhatsApp Business number this app sends FROM, E.164, e.g. +917026392424
    source: process.env.GUPSHUP_SOURCE,
    // The predefined destination (pharmacist/store) WhatsApp number, E.164, e.g. +919540317803
    sendTo: process.env.GUPSHUP_SEND_TO,
    // Secondary doctor WhatsApp number. Sent the same prescription template
    // at the same time as the primary number — whichever doctor responds
    // first, the other gets a status notification instead of acting on a
    // stale request. Optional — if unset, only the primary doctor is
    // notified and there's no cross-notify.
    sendToSecondary: process.env.GUPSHUP_SEND_TO_SECONDARY,
    // Tertiary doctor WhatsApp number, notified at the same time as the
    // other two. Optional — if unset, only primary (+ secondary, if set)
    // are notified.
    sendToTertiary: process.env.GUPSHUP_SEND_TO_TERTIARY,
    // Approved HSM template ID from Gupshup Console > Templates
    templateId: process.env.GUPSHUP_TEMPLATE_ID,
    // Approved HSM template ID for notifying the customer of an approve/reject decision
    statusTemplateId: process.env.GUPSHUP_STATUS_TEMPLATE_ID,
    // Approved HSM template ID for notifying the OTHER doctor (not the one
    // who responded) that a request was already handled — takes {1: customer
    // name, 2: responding doctor's name, 3: Approved/Rejected}. Optional:
    // until this is approved and set, the other-doctor notify falls back to
    // reusing statusTemplateId with the product list instead of a doctor name.
    doctorStatusTemplateId: process.env.GUPSHUP_DOCTOR_STATUS_TEMPLATE_ID,
    // Display names for the primary/secondary/tertiary doctor numbers above,
    // used to fill the doctor-status template's "responding doctor's name"
    // variable.
    primaryDoctorName: process.env.GUPSHUP_PRIMARY_DOCTOR_NAME,
    secondaryDoctorName: process.env.GUPSHUP_SECONDARY_DOCTOR_NAME,
    tertiaryDoctorName: process.env.GUPSHUP_TERTIARY_DOCTOR_NAME,
    // App name registered on Gupshup, required by the API as "src.name"
    appName: process.env.GUPSHUP_APP_NAME,
  },

  // HMAC secret shown when the orders/create webhook is registered (Shopify
  // Admin > Settings > Notifications > Webhooks, or a custom app's client
  // secret if registered via the Admin API) — used to verify incoming
  // webhook requests actually came from Shopify.
  shopifyWebhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,

  shopify: {
    // your-store.myshopify.com — used to call back into the Admin API.
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
    // Custom app Admin API access token with write_orders scope (Admin >
    // Settings > Apps and sales channels > Develop apps).
    adminApiToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-01',
    // Namespace/key for the order metafield that flags whether the order
    // contains an Rx product. Defaults match a no-code "custom data"
    // definition created in Admin > Settings > Custom data > Orders.
    rxMetafieldNamespace: process.env.SHOPIFY_RX_METAFIELD_NAMESPACE || 'custom',
    rxMetafieldKey: process.env.SHOPIFY_RX_METAFIELD_KEY || 'rx-prescription-order',
  },

  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB) || 10,

  s3: {
    bucket: process.env.S3_BUCKET_NAME,
    region: process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1',
  },

  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
};

function validateConfig() {
  const requiredVars = [
    'GUPSHUP_API_KEY',
    'GUPSHUP_SOURCE',
    'GUPSHUP_SEND_TO',
    'GUPSHUP_TEMPLATE_ID',
    'GUPSHUP_STATUS_TEMPLATE_ID',
    'GUPSHUP_APP_NAME',
  ];
  const missing = requiredVars.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = { config, validateConfig, required };
