const twilio = require('twilio');
const { config } = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

function toWhatsAppAddress(e164Number) {
  return `whatsapp:${e164Number}`;
}

/**
 * Twilio requires an approved Content Template for business-initiated messages
 * sent outside an open 24h session, so the name/phone notification always goes
 * out via contentSid + contentVariables rather than a freeform body.
 */
async function sendTemplateMessage({ contentVariables }) {
  try {
    const message = await client.messages.create({
      from: toWhatsAppAddress(config.twilio.whatsappFrom),
      to: toWhatsAppAddress(config.twilio.whatsappTo),
      contentSid: config.twilio.contentSid,
      contentVariables: JSON.stringify(contentVariables),
    });
    return message;
  } catch (err) {
    logger.error('Twilio template message failed', { error: err.message, code: err.code });
    throw new ApiError(502, 'Failed to send WhatsApp template message via Twilio', {
      code: err.code,
      message: err.message,
    });
  }
}

/**
 * The prescription file itself is sent as a plain media message. This only
 * succeeds if there's an open WhatsApp session with the destination number
 * (e.g. the template message above just opened/refreshed one).
 */
async function sendMediaMessage({ mediaUrl, body }) {
  try {
    const message = await client.messages.create({
      from: toWhatsAppAddress(config.twilio.whatsappFrom),
      to: toWhatsAppAddress(config.twilio.whatsappTo),
      mediaUrl: [mediaUrl],
      body,
    });
    return message;
  } catch (err) {
    logger.error('Twilio media message failed', { error: err.message, code: err.code });
    throw new ApiError(502, 'Failed to send WhatsApp media message via Twilio', {
      code: err.code,
      message: err.message,
    });
  }
}

module.exports = { sendTemplateMessage, sendMediaMessage };
