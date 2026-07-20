const { config } = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const BASE_URL = 'https://api.gupshup.io/wa/api/v1';
const DOCUMENT_EXTENSIONS = new Set(['.pdf']);

function toApiNumber(e164Number) {
  return e164Number.replace(/^\+/, '');
}

async function postToGupshup(path, params) {
  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: toApiNumber(config.gupshup.source),
    destination: toApiNumber(config.gupshup.sendTo),
    'src.name': config.gupshup.appName,
    ...params,
  });

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: config.gupshup.apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await response.json();
  if (!response.ok || data?.status === 'error') {
    throw new Error(data?.message || `Gupshup API returned status ${response.status}`);
  }
  return data;
}

/**
 * WhatsApp requires business-initiated messages to use an approved template
 * outside an open 24h session, so the name/phone notification always goes
 * out via the template endpoint (template id + ordered params) rather than
 * a freeform message.
 */
async function sendTemplateMessage({ contentVariables }) {
  try {
    const params = Object.keys(contentVariables)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => contentVariables[key]);

    return await postToGupshup('/template/msg', {
      template: JSON.stringify({ id: config.gupshup.templateId, params }),
    });
  } catch (err) {
    logger.error('Gupshup template message failed', { error: err.message });
    throw new ApiError(502, 'Failed to send WhatsApp template message via Gupshup', {
      message: err.message,
    });
  }
}

/**
 * The prescription file itself is sent as a plain session message. This only
 * succeeds if there's an open WhatsApp session with the destination number
 * (e.g. the template message above just opened/refreshed one).
 */
async function sendMediaMessage({ mediaUrl, body, fileExtension }) {
  const isDocument = DOCUMENT_EXTENSIONS.has((fileExtension || '').toLowerCase());
  const message = isDocument
    ? { type: 'file', url: mediaUrl, filename: 'prescription.pdf' }
    : { type: 'image', originalUrl: mediaUrl, caption: body };

  try {
    return await postToGupshup('/msg', { message: JSON.stringify(message) });
  } catch (err) {
    logger.error('Gupshup media message failed', { error: err.message });
    throw new ApiError(502, 'Failed to send WhatsApp media message via Gupshup', {
      message: err.message,
    });
  }
}

module.exports = { sendTemplateMessage, sendMediaMessage };
