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
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
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

  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB) || 10,
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
