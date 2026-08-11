const crypto = require('crypto');
const { config } = require('../config/env');
const logger = require('../utils/logger');
const gupshupService = require('../services/gupshup.service');
const shopifyService = require('../services/shopify.service');
const { createPrescriptionRequest, existsByShopifyOrderId } = require('../repositories/prescriptionRequest.repository');
const { consumePendingUpload } = require('../repositories/pendingPrescriptionUpload.repository');

// Generic banner used as the required template image header for consult
// requests, which have no prescription file to attach.
const CONSULT_HEADER_IMAGE_URL = 'https://zigly.com/cdn/shop/files/1920X360_vetfirst_banner.png?v=1776228816&width=2000';

function verifySignature(rawBody, hmacHeader) {
  if (!config.shopifyWebhookSecret || !hmacHeader || !rawBody) return false;
  const digest = crypto.createHmac('sha256', config.shopifyWebhookSecret).update(rawBody).digest('base64');
  const digestBuffer = Buffer.from(digest);
  const headerBuffer = Buffer.from(hmacHeader);
  if (digestBuffer.length !== headerBuffer.length) return false;
  return crypto.timingSafeEqual(digestBuffer, headerBuffer);
}

// Shopify's REST order payload represents line-item properties as an array
// of {name, value} pairs (unlike the cart AJAX API, which exposes them as a
// plain object) — this pulls out only the ones flagged at add-to-cart time
// (see buy-buttons.liquid / card-product.liquid).
function findPrescriptionLineItems(lineItems) {
  return (lineItems || [])
    .filter((item) => (item.properties || []).some((p) => p.name === '_requires_prescription' && p.value === 'true'))
    .map((item) => ({
      product_id: item.product_id,
      title: item.title,
      quantity: item.quantity,
      // Captured (not yet consumed anywhere) so a later Approve/Reject action
      // can identify this exact line item on the order without a lookup —
      // CalculatedLineItem has no back-reference to the original LineItem id,
      // so variant_id is what the Order Edit API match will key off instead.
      variant_id: item.variant_id,
    }));
}

function resolveCustomer(order) {
  const address = order.shipping_address || order.billing_address || {};
  const customer = order.customer || {};
  const name =
    [address.first_name, address.last_name].filter(Boolean).join(' ').trim() ||
    [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() ||
    'Customer';
  const phone = order.phone || customer.phone || address.phone || '';
  return { name, phone };
}

// The cart drawer stages the uploaded photo to S3 and tags the cart with the
// returned key as a cart attribute *before* checkout; Shopify carries cart
// attributes through into the order as note_attributes.
function findUploadKey(order) {
  const match = (order.note_attributes || []).find((a) => a.name === 'prescription_upload_key');
  return match ? match.value : null;
}

function findLandingPageUrl(order) {
  const match = (order.note_attributes || []).find((a) => a.name === 'landing_page_url');
  return match ? match.value : '';
}

// While this feature is still being tested, only process orders that came
// from theme-preview traffic — never real zigly.com customers. Controlled by
// config.shopify.orderOriginAllowlist (see env.js); an empty allowlist means
// "process every order" for once this is ready to go live.
function isAllowedOrderOrigin(order) {
  if (!config.shopify.orderOriginAllowlist) return true;
  return findLandingPageUrl(order).includes(config.shopify.orderOriginAllowlist);
}

function summarizeProducts(products) {
  return products
    .map((product) => {
      const title = product.title || 'Item';
      return product.quantity > 1 ? `${title} (x${product.quantity})` : title;
    })
    .join(', ');
}

async function handleOrderCreate(req, res) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

  if (!verifySignature(req.rawBody, hmacHeader)) {
    logger.warn('Shopify webhook signature verification failed');
    return res.status(401).json({ success: false, message: 'Invalid signature' });
  }

  // Everything below must finish *before* responding: this runs on Lambda,
  // which freezes the execution environment as soon as the response promise
  // resolves, silently killing any "fire and forget" work queued after an
  // early ack (confirmed via a diagnostic log that showed line items with
  // _requires_prescription correctly detected, but no further log line ever
  // ran). A Gupshup call + a couple of Postgres queries comfortably finish
  // well inside Shopify's webhook timeout, so there's no need to ack early.
  try {
    const order = req.body;
    const shopifyOrderId = order.name || String(order.id);

    if (!isAllowedOrderOrigin(order)) {
      logger.info('Skipping orders/create webhook: order origin not in the test allowlist', {
        shopifyOrderId,
        landingPageUrl: findLandingPageUrl(order),
      });
      return res.status(200).json({ success: true });
    }

    const prescriptionItems = findPrescriptionLineItems(order.line_items);
    const orderGid = order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`;

    // Runs for every order (not just Rx ones) so the flag is always accurate,
    // regardless of the early-returns below for non-Rx / duplicate orders.
    try {
      await shopifyService.setRxProductOrderMetafield(orderGid, prescriptionItems.length > 0);
    } catch (err) {
      logger.error('Failed to set rx_prescription_order metafield', { error: err.message, shopifyOrderId });
    }

    // The tag (not the metafield above) is what the Unicommerce connector
    // actually watches to hold the order — only added when there's an Rx
    // item, since tags are naturally absent otherwise (no "false" case).
    if (prescriptionItems.length) {
      try {
        await shopifyService.addOrderTag(orderGid, config.shopify.rxTagName);
      } catch (err) {
        logger.error('Failed to add rx_prescription_order tag', { error: err.message, shopifyOrderId });
      }
    }

    if (!prescriptionItems.length) {
      return res.status(200).json({ success: true });
    }

    if (await existsByShopifyOrderId(shopifyOrderId)) {
      logger.info('Skipping duplicate orders/create webhook delivery', { shopifyOrderId });
      return res.status(200).json({ success: true });
    }

    const { name, phone } = resolveCustomer(order);
    if (!phone) {
      logger.error('orders/create webhook has Rx line items but no phone on the order', { shopifyOrderId });
      return res.status(200).json({ success: true });
    }

    let headerImageUrl = CONSULT_HEADER_IMAGE_URL;
    let method = 'consult';
    let fileUrl = null;
    const uploadKey = findUploadKey(order);
    if (uploadKey) {
      const stagedFileUrl = await consumePendingUpload(uploadKey);
      if (stagedFileUrl) {
        headerImageUrl = stagedFileUrl;
        fileUrl = stagedFileUrl;
        method = 'upload';
      } else {
        logger.warn('orders/create webhook had a prescription_upload_key with no matching staged upload', {
          shopifyOrderId,
          uploadKey,
        });
      }
    }

    const { primaryMessageId, secondaryMessageId, tertiaryMessageId, quaternaryMessageId } = await gupshupService.sendTemplateMessageToDoctors({
      contentVariables: { 1: name, 2: phone, 3: summarizeProducts(prescriptionItems) },
      headerImageUrl,
    });

    logger.info('Prescription request forwarded to WhatsApp from orders/create webhook', {
      shopifyOrderId,
      name,
      phone,
      method,
      products: prescriptionItems,
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
        method,
        fileUrl,
        products: prescriptionItems,
        medicineName: summarizeProducts(prescriptionItems),
        shopifyOrderId,
        shopifyOrderGid: orderGid,
      });
    } catch (dbErr) {
      logger.error('Failed to persist prescription request from webhook', { error: dbErr.message, shopifyOrderId });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('Failed to process orders/create webhook', { error: err.message, stack: err.stack });
    res.status(200).json({ success: true });
  }
}

module.exports = { handleOrderCreate };
