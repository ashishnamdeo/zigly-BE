const path = require('path');
const { config } = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const gupshupService = require('../services/gupshup.service');

const PHONE_REGEX = /^\+?[0-9]{8,15}$/;

function validateInput({ name, phone }, file) {
  if (!name || !name.trim()) {
    throw new ApiError(400, 'Customer name is required');
  }
  if (!phone || !PHONE_REGEX.test(phone.trim())) {
    throw new ApiError(400, 'A valid phone number (8-15 digits, optional leading +) is required');
  }
  if (!file) {
    throw new ApiError(400, 'A prescription file (JPG, PNG, or PDF) is required');
  }
}

async function uploadPrescription(req, res, next) {
  const { name, phone } = req.body;
  const file = req.file;

  try {
    validateInput({ name, phone }, file);

    const publicFileUrl = `${config.appBaseUrl}/uploads/${file.filename}`;

    // Notification text goes through the approved HSM template so it's
    // delivered even without an already-open WhatsApp session. Adjust the "1"/"2"
    // keys below to match your actual template's placeholder order.
    await gupshupService.sendTemplateMessage({
      contentVariables: { 1: name, 2: phone },
    });

    // The template message above opens/refreshes the session, so the file can
    // follow as a plain media message.
    await gupshupService.sendMediaMessage({
      mediaUrl: publicFileUrl,
      body: `Prescription from ${name} (${phone})`,
      fileExtension: path.extname(file.filename),
    });

    logger.info('Prescription forwarded to WhatsApp', { name, phone, file: file.filename });

    res.status(200).json({
      success: true,
      message: 'Prescription uploaded and sent via WhatsApp successfully',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { uploadPrescription };
