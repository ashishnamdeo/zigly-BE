const { v4: uuidv4 } = require('uuid');
const path = require('path');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const gupshupService = require('../services/gupshup.service');
const s3Service = require('../services/s3.service');
const { ALLOWED_MIME_TYPES } = require('../middleware/upload.middleware');
const { createPrescriptionRequest } = require('../repositories/prescriptionRequest.repository');

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

function parseProducts(rawProducts) {
  if (!rawProducts) return [];
  try {
    const parsed = JSON.parse(rawProducts);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function summarizeProducts(products) {
  return products
    .map((product) => {
      const title = product.title || 'Item';
      return product.quantity > 1 ? `${title} (x${product.quantity})` : title;
    })
    .join(', ');
}

async function uploadPrescription(req, res, next) {
  const { name, phone } = req.body;
  const file = req.file;

  try {
    validateInput({ name, phone }, file);
    const products = parseProducts(req.body.products);

    const filename = `${uuidv4()}${ALLOWED_MIME_TYPES[file.mimetype] || path.extname(file.originalname)}`;
    const publicFileUrl = await s3Service.uploadPrescriptionFile({
      buffer: file.buffer,
      filename,
      mimeType: file.mimetype,
    });

    // The approved template has an image header, so the prescription photo
    // and the name/phone/products notification text go out together in a
    // single template send. Adjust the "1"/"2"/"3" keys below to match your
    // actual template's placeholder order.
    // NOTE: for PDF uploads this still sends the PDF as the header "image",
    // which WhatsApp will likely reject — PDFs need a real fallback header
    // image or a separate document-message flow, still to be resolved.
    const templateResult = await gupshupService.sendTemplateMessage({
      contentVariables: { 1: name, 2: phone, 3: summarizeProducts(products) },
      headerImageUrl: publicFileUrl,
    });

    logger.info('Prescription forwarded to WhatsApp', {
      name,
      phone,
      products,
      file: filename,
      fileUrl: publicFileUrl,
      templateResult,
    });

    try {
      await createPrescriptionRequest({
        gupshupMessageId: templateResult.messageId,
        customerName: name,
        customerPhone: phone,
        method: 'upload',
        fileUrl: publicFileUrl,
        products,
      });
    } catch (dbErr) {
      // The WhatsApp message already went out — don't fail the request over
      // a DB write, but this does mean the Approve/Reject webhook won't be
      // able to match this request back later.
      logger.error('Failed to persist prescription request', { error: dbErr.message });
    }

    res.status(200).json({
      success: true,
      message: 'Prescription uploaded and sent via WhatsApp successfully',
      imageUrl: publicFileUrl,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { uploadPrescription };
