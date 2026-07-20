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

    // The approved template has an image header, so the prescription photo
    // and the name/phone notification text go out together in a single
    // template send. Adjust the "1"/"2" keys below to match your actual
    // template's placeholder order.
    // NOTE: for PDF uploads this still sends the PDF as the header "image",
    // which WhatsApp will likely reject — PDFs need a real fallback header
    // image or a separate document-message flow, still to be resolved.
    const templateResult = await gupshupService.sendTemplateMessage({
      contentVariables: { 1: name, 2: phone },
      headerImageUrl: publicFileUrl,
    });

    logger.info('Prescription forwarded to WhatsApp', {
      name,
      phone,
      file: file.filename,
      templateResult,
    });

    res.status(200).json({
      success: true,
      message: 'Prescription uploaded and sent via WhatsApp successfully',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { uploadPrescription };
