const { config } = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const BASE_URL = 'https://api.gupshup.io/wa/api/v1';
const DOCUMENT_EXTENSIONS = new Set(['.pdf']);

function toApiNumber(e164Number) {
  return e164Number.replace(/^\+/, '');
}

async function postToGupshup(path, params, { destination } = {}) {
  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: toApiNumber(config.gupshup.source),
    destination: toApiNumber(destination || config.gupshup.sendTo),
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
 * a freeform message. The approved template has an image header, which must
 * be supplied via a separate "message" field alongside "template" — putting
 * the image URL inside template.params returns a (#2012) format-mismatch error.
 */
async function sendTemplateMessage({ contentVariables, headerImageUrl, destination, templateId }) {
  try {
    const params = Object.keys(contentVariables)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => contentVariables[key]);

    const payload = {
      template: JSON.stringify({ id: templateId || config.gupshup.templateId, params }),
    };
    if (headerImageUrl) {
      payload.message = JSON.stringify({ type: 'image', image: { link: headerImageUrl } });
    }

    return await postToGupshup('/template/msg', payload, { destination });
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

/**
 * Plain session text — no approved template needed, since this only ever
 * follows the doctor's own button tap, which opens/refreshes their 24h
 * customer-service window. Used for the "you already decided this one"
 * double-tap notice, which has no approved HSM template of its own.
 */
async function sendTextMessage({ to, text }) {
  try {
    return await postToGupshup('/msg', { message: JSON.stringify({ type: 'text', text }) }, { destination: to });
  } catch (err) {
    logger.error('Gupshup text message failed', { error: err.message, to });
    throw new ApiError(502, 'Failed to send WhatsApp text message via Gupshup', {
      message: err.message,
    });
  }
}

/**
 * Notifies the customer of an approve/reject decision via the approved
 * prescription_status_update template, so delivery doesn't depend on an
 * open 24h WhatsApp session with that number the way a plain text message
 * would.
 */
async function sendStatusTemplateMessage({ to, contentVariables, templateId }) {
  try {
    const params = Object.keys(contentVariables)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => contentVariables[key]);

    const payload = {
      template: JSON.stringify({ id: templateId || config.gupshup.statusTemplateId, params }),
    };

    return await postToGupshup('/template/msg', payload, { destination: to });
  } catch (err) {
    logger.error('Gupshup status template message failed', { error: err.message, to });
    throw new ApiError(502, 'Failed to send WhatsApp status update to customer', {
      message: err.message,
    });
  }
}

module.exports = {
  sendTemplateMessage,
  sendMediaMessage,
  sendTextMessage,
  sendStatusTemplateMessage,
};
