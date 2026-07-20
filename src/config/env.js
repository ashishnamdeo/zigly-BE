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
    userId: process.env.GUPSHUP_USERID,
    password: process.env.GUPSHUP_PASSWORD,
    // The predefined destination (pharmacist/store) WhatsApp number, E.164, e.g. +919540317803
    sendTo: process.env.GUPSHUP_SEND_TO,
    // Approved HSM template text with {{1}}/{{2}} placeholders, e.g.
    // "New prescription received from {{1}}, phone {{2}}."
    templateText: process.env.GUPSHUP_TEMPLATE_TEXT,
  },

  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB) || 10,
};

function validateConfig() {
  const requiredVars = [
    'GUPSHUP_USERID',
    'GUPSHUP_PASSWORD',
    'GUPSHUP_SEND_TO',
    'GUPSHUP_TEMPLATE_TEXT',
  ];
  const missing = requiredVars.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = { config, validateConfig, required };
