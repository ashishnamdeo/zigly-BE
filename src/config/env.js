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
    // Approved HSM template ID from Gupshup Console > Templates
    templateId: process.env.GUPSHUP_TEMPLATE_ID,
    // App name registered on Gupshup, required by the API as "src.name"
    appName: process.env.GUPSHUP_APP_NAME,
  },

  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB) || 10,

  shopify: {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
    adminToken: process.env.SHOPIFY_ADMIN_TOKEN,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2025-01',
  },
};

function validateConfig() {
  const requiredVars = [
    'GUPSHUP_API_KEY',
    'GUPSHUP_SOURCE',
    'GUPSHUP_SEND_TO',
    'GUPSHUP_TEMPLATE_ID',
    'GUPSHUP_APP_NAME',
  ];
  const missing = requiredVars.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = { config, validateConfig, required };
