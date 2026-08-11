const { v4: uuidv4 } = require('uuid');
const path = require('path');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const gupshupService = require('../services/gupshup.service');
const s3Service = require('../services/s3.service');
const { ALLOWED_MIME_TYPES } = require('../middleware/upload.middleware');
const {
  createPrescriptionRequest,
  findRecentByPhone,
  existsByShopifyOrderId,
} = require('../repositories/prescriptionRequest.repository');
const { createPendingUpload } = require('../repositories/pendingPrescriptionUpload.repository');

const PHONE_REGEX = /^\+?[0-9]{8,15}$/;
const MAX_PRODUCT_IDS = 100;

// Generic banner used as the required template image header for consult
// requests, which have no prescription file to attach.
const CONSULT_HEADER_IMAGE_URL = 'https://zigly.com/cdn/shop/files/1920X360_vetfirst_banner.png?v=1776228816&width=2000';

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

function validateConsultInput({ name, phone }) {
  if (!name || !name.trim()) {
    throw new ApiError(400, 'Customer name is required');
  }
  if (!phone || !PHONE_REGEX.test(phone.trim())) {
    throw new ApiError(400, 'A valid phone number (8-15 digits, optional leading +) is required');
  }
}

function validateStatusInput({ phone, productIds }) {
  if (!phone || !PHONE_REGEX.test(String(phone).trim())) {
    throw new ApiError(400, 'A valid phone number (8-15 digits, optional leading +) is required');
  }
  if (!Array.isArray(productIds) || !productIds.length) {
    throw new ApiError(400, 'productIds must be a non-empty array');
  }
  if (productIds.length > MAX_PRODUCT_IDS) {
    throw new ApiError(400, `productIds cannot exceed ${MAX_PRODUCT_IDS} entries`);
  }
  if (productIds.some((id) => !Number.isFinite(Number(id)))) {
    throw new ApiError(400, 'productIds must all be numeric ids');
  }
}

function validateAutoConsultInput({ name, phone, products }) {
  if (!name || !String(name).trim()) {
    throw new ApiError(400, 'Customer name is required');
  }
  if (!phone || !PHONE_REGEX.test(String(phone).trim())) {
    throw new ApiError(400, 'A valid phone number (8-15 digits, optional leading +) is required');
  }
  if (!Array.isArray(products) || !products.length) {
    throw new ApiError(400, 'products must be a non-empty array');
  }
}

function validateAutoUploadInput({ name, phone }, file) {
  if (!name || !String(name).trim()) {
    throw new ApiError(400, 'Customer name is required');
  }
  if (!phone || !PHONE_REGEX.test(String(phone).trim())) {
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
    const { primaryMessageId, secondaryMessageId, tertiaryMessageId, quaternaryMessageId } = await gupshupService.sendTemplateMessageToDoctors({
      contentVariables: { 1: name, 2: phone, 3: summarizeProducts(products) },
      headerImageUrl: publicFileUrl,
    });

    logger.info('Prescription forwarded to WhatsApp', {
      name,
      phone,
      products,
      file: filename,
      fileUrl: publicFileUrl,
      primaryMessageId,
      secondaryMessageId,
      tertiaryMessageId,
    });

    try {
      await createPrescriptionRequest({
        gupshupMessageId: primaryMessageId,
        secondaryGupshupMessageId: secondaryMessageId,
        tertiaryGupshupMessageId: tertiaryMessageId,
        quaternaryGupshupMessageId: quaternaryMessageId,
        customerName: name,
        customerPhone: phone,
        method: 'upload',
        fileUrl: publicFileUrl,
        products,
        medicineName: summarizeProducts(products),
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

async function requestConsultation(req, res, next) {
  const { name, phone } = req.body;

  try {
    validateConsultInput({ name, phone });
    const products = parseProducts(req.body.products);

    const { primaryMessageId, secondaryMessageId, tertiaryMessageId, quaternaryMessageId } = await gupshupService.sendTemplateMessageToDoctors({
      contentVariables: { 1: name, 2: phone, 3: summarizeProducts(products) },
      headerImageUrl: CONSULT_HEADER_IMAGE_URL,
    });

    logger.info('Consultation request forwarded to WhatsApp', {
      name,
      phone,
      products,
      primaryMessageId,
      secondaryMessageId,
      tertiaryMessageId,
    });

    try {
      await createPrescriptionRequest({
        gupshupMessageId: primaryMessageId,
        secondaryGupshupMessageId: secondaryMessageId,
        tertiaryGupshupMessageId: tertiaryMessageId,
        quaternaryGupshupMessageId: quaternaryMessageId,
        customerName: name,
        customerPhone: phone,
        method: 'consult',
        fileUrl: null,
        products,
        medicineName: summarizeProducts(products),
      });
    } catch (dbErr) {
      logger.error('Failed to persist consultation request', { error: dbErr.message });
    }

    res.status(200).json({
      success: true,
      message: 'Consultation request sent via WhatsApp successfully',
    });
  } catch (err) {
    next(err);
  }
}

async function getPrescriptionStatus(req, res, next) {
  const { phone, productIds } = req.body;

  try {
    validateStatusInput({ phone, productIds });
    const wantedIds = new Set(productIds.map((id) => String(id)));

    const rows = await findRecentByPhone(String(phone).trim());

    const statuses = {};
    for (const row of rows) {
      for (const product of row.products || []) {
        const productId = String(product.product_id);
        if (wantedIds.has(productId) && !statuses[productId]) {
          statuses[productId] = {
            status: row.status,
            createdAt: row.created_at,
            respondedAt: row.responded_at,
          };
        }
      }
    }

    res.status(200).json({ success: true, statuses });
  } catch (err) {
    next(err);
  }
}

/**
 * Fires automatically from the storefront once the Fastrr/Shiprocket headless
 * checkout reports an ORDER_PLACED event — there's no manual name/phone entry
 * form involved, but name/phone still arrive here as plain fields: the
 * storefront resolves them client-side (via Pickrr's own order-lookup API,
 * which requires a browser session our backend has no way to obtain) and
 * passes the result straight through.
 */
async function autoConsultFromOrder(req, res, next) {
  const { name, phone, orderId, cartId, products } = req.body;

  try {
    validateAutoConsultInput({ name, phone, products });

    // The orders/create webhook (shopifyWebhook.controller.js) now also
    // handles this reliably and server-side — skip if it already sent this
    // order's notification, so the customer/pharmacist doesn't get it twice.
    if (orderId && (await existsByShopifyOrderId(orderId))) {
      logger.info('Skipping auto-consult, order already handled by orders/create webhook', { orderId });
      return res.status(200).json({ success: true, name, phone });
    }

    const { primaryMessageId, secondaryMessageId, tertiaryMessageId, quaternaryMessageId } = await gupshupService.sendTemplateMessageToDoctors({
      contentVariables: { 1: name, 2: phone, 3: summarizeProducts(products) },
      headerImageUrl: CONSULT_HEADER_IMAGE_URL,
    });

    logger.info('Auto-consult request forwarded to WhatsApp', {
      orderId,
      cartId,
      name,
      phone,
      products,
      primaryMessageId,
      secondaryMessageId,
      tertiaryMessageId,
    });

    try {
      await createPrescriptionRequest({
        gupshupMessageId: primaryMessageId,
        secondaryGupshupMessageId: secondaryMessageId,
        tertiaryGupshupMessageId: tertiaryMessageId,
        quaternaryGupshupMessageId: quaternaryMessageId,
        customerName: name,
        customerPhone: phone,
        method: 'consult',
        fileUrl: null,
        products,
        medicineName: summarizeProducts(products),
        shopifyOrderId: orderId || null,
      });
    } catch (dbErr) {
      logger.error('Failed to persist auto-consult request', { error: dbErr.message });
    }

    res.status(200).json({ success: true, name, phone });
  } catch (err) {
    next(err);
  }
}

/**
 * Same idea as autoConsultFromOrder, but for a customer who staged a file in
 * the cart drawer before checkout — the file itself can only ever come from
 * the browser, so it's sent here at the ORDER_PLACED moment (while the file
 * is still in memory client-side) rather than through the JSON-only
 * auto-consult endpoint. Name/phone are resolved client-side the same way.
 */
async function autoUploadFromOrder(req, res, next) {
  const { name, phone, orderId, cartId } = req.body;
  const file = req.file;

  try {
    const products = parseProducts(req.body.products);
    validateAutoUploadInput({ name, phone }, file);

    if (orderId && (await existsByShopifyOrderId(orderId))) {
      logger.info('Skipping auto-upload, order already handled by orders/create webhook', { orderId });
      return res.status(200).json({ success: true, name, phone });
    }

    const filename = `${uuidv4()}${ALLOWED_MIME_TYPES[file.mimetype] || path.extname(file.originalname)}`;
    const publicFileUrl = await s3Service.uploadPrescriptionFile({
      buffer: file.buffer,
      filename,
      mimeType: file.mimetype,
    });

    const { primaryMessageId, secondaryMessageId, tertiaryMessageId, quaternaryMessageId } = await gupshupService.sendTemplateMessageToDoctors({
      contentVariables: { 1: name, 2: phone, 3: summarizeProducts(products) },
      headerImageUrl: publicFileUrl,
    });

    logger.info('Auto-upload prescription forwarded to WhatsApp', {
      orderId,
      cartId,
      name,
      phone,
      products,
      file: filename,
      fileUrl: publicFileUrl,
      primaryMessageId,
      secondaryMessageId,
      tertiaryMessageId,
    });

    try {
      await createPrescriptionRequest({
        gupshupMessageId: primaryMessageId,
        secondaryGupshupMessageId: secondaryMessageId,
        tertiaryGupshupMessageId: tertiaryMessageId,
        quaternaryGupshupMessageId: quaternaryMessageId,
        customerName: name,
        customerPhone: phone,
        method: 'upload',
        fileUrl: publicFileUrl,
        products,
        medicineName: summarizeProducts(products),
        shopifyOrderId: orderId || null,
      });
    } catch (dbErr) {
      logger.error('Failed to persist auto-upload prescription request', { error: dbErr.message });
    }

    res.status(200).json({ success: true, name, phone });
  } catch (err) {
    next(err);
  }
}

/**
 * Uploads a prescription photo to S3 the moment it's picked in the cart
 * drawer (still on zigly.com, so no post-ORDER_PLACED timing/reliability
 * risk) and returns a key. The cart drawer then tags the Shopify cart with
 * that key as a cart attribute, which Shopify carries through into the
 * resulting order's note_attributes — letting the orders/create webhook
 * (see shopifyWebhook.controller.js) look up the real photo itself instead
 * of depending on any client call surviving checkout.
 */
async function stagePrescriptionUpload(req, res, next) {
  const file = req.file;

  try {
    if (!file) {
      throw new ApiError(400, 'A prescription file (JPG, PNG, or PDF) is required');
    }

    const filename = `${uuidv4()}${ALLOWED_MIME_TYPES[file.mimetype] || path.extname(file.originalname)}`;
    const publicFileUrl = await s3Service.uploadPrescriptionFile({
      buffer: file.buffer,
      filename,
      mimeType: file.mimetype,
    });

    const key = uuidv4();
    await createPendingUpload({ key, fileUrl: publicFileUrl });

    logger.info('Staged prescription upload ahead of checkout', { key, fileUrl: publicFileUrl });

    res.status(200).json({ success: true, key });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  uploadPrescription,
  requestConsultation,
  getPrescriptionStatus,
  autoConsultFromOrder,
  autoUploadFromOrder,
  stagePrescriptionUpload,
};
