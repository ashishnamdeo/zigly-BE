const { config } = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const GATEWAY_URL = 'https://media.smsgupshup.com/GatewayAPI/rest';
const DOCUMENT_EXTENSIONS = new Set(['.pdf']);

function baseParams() {
  return {
    userid: config.gupshup.userId,
    password: config.gupshup.password,
    auth_scheme: 'plain',
    v: '1.1',
    format: 'text',
  };
}

async function postToGupshup(params) {
  const body = new URLSearchParams({ ...baseParams(), ...params });
  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json();
  if (data?.response?.status !== 'success') {
    throw new Error(data?.response?.details || 'Gupshup API returned a failure response');
  }
  return data;
}

function renderTemplate(contentVariables) {
  return Object.entries(contentVariables).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(value),
    config.gupshup.templateText
  );
}

/**
 * WhatsApp requires business-initiated messages to use an approved HSM
 * template outside an open 24h session, so the name/phone notification
 * always goes out via isHSM/isTemplate with the template text pre-filled
 * (Gupshup matches the resolved text against the approved template).
 */
async function sendTemplateMessage({ contentVariables }) {
  try {
    return await postToGupshup({
      send_to: config.gupshup.sendTo,
      method: 'SendMessage',
      msg_type: 'TEXT',
      msg: renderTemplate(contentVariables),
      isHSM: 'true',
      isTemplate: 'true',
    });
  } catch (err) {
    logger.error('Gupshup template message failed', { error: err.message });
    throw new ApiError(502, 'Failed to send WhatsApp template message via Gupshup', {
      message: err.message,
    });
  }
}

/**
 * The prescription file itself is sent as a plain media message. This only
 * succeeds if there's an open WhatsApp session with the destination number
 * (e.g. the template message above just opened/refreshed one).
 */
async function sendMediaMessage({ mediaUrl, body, fileExtension }) {
  const msgType = DOCUMENT_EXTENSIONS.has((fileExtension || '').toLowerCase()) ? 'DOCUMENT' : 'IMAGE';
  try {
    return await postToGupshup({
      send_to: config.gupshup.sendTo,
      method: 'SendMediaMessage',
      msg_type: msgType,
      media_url: mediaUrl,
      caption: body,
    });
  } catch (err) {
    logger.error('Gupshup media message failed', { error: err.message });
    throw new ApiError(502, 'Failed to send WhatsApp media message via Gupshup', {
      message: err.message,
    });
  }
}

module.exports = { sendTemplateMessage, sendMediaMessage };
