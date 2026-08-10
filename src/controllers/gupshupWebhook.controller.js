const { config } = require('../config/env');
const logger = require('../utils/logger');
const gupshupService = require('../services/gupshup.service');
const shopifyOrderEditService = require('../services/shopifyOrderEdit.service');
const {
  updateStatusByMessageId,
  findByMessageId,
} = require('../repositories/prescriptionRequest.repository');

const BUTTON_TO_STATUS = {
  approve: 'approved',
  reject: 'rejected',
};

const STATUS_LABEL = {
  approved: 'Approved',
  rejected: 'Rejected',
};

function summarizeProducts(products) {
  return (products || [])
    .map((product) => {
      const title = product.title || 'Item';
      return product.quantity > 1 ? `${title} (x${product.quantity})` : title;
    })
    .join(', ');
}

/**
 * Verified against a real button tap: Gupshup sends
 * { type: "message", payload: { type: "quick_reply", payload: { text, postbackText },
 *   context: { id, gsId } } }. The template-send response's "messageId" (what we store
 * as gupshup_message_id) corresponds to context.gsId, not context.id.
 */
function extractButtonReply(body) {
  const payload = body?.payload;
  if (!payload || payload.type !== 'quick_reply') return null;

  const buttonText = payload.payload?.text || payload.payload?.postbackText;
  const originalMessageId = payload.context?.gsId;
  if (!buttonText || !originalMessageId) return null;

  const status = BUTTON_TO_STATUS[buttonText.trim().toLowerCase()];
  if (!status) return null;

  return { status, originalMessageId };
}

async function notifyCustomer(updated, status, productsText) {
  try {
    await gupshupService.sendStatusTemplateMessage({
      to: updated.customer_phone,
      contentVariables: {
        1: updated.customer_name,
        2: productsText || 'your prescription request',
        3: STATUS_LABEL[status],
      },
    });
  } catch (notifyErr) {
    logger.error('Failed to notify customer of status update', { error: notifyErr.message, id: updated.id });
  }
}

// The fixed set of doctor slots this app knows about — DB columns and env
// vars are named per-role (primary/secondary/tertiary) rather than a dynamic
// list, so this mapping is spelled out explicitly instead of derived.
function getConfiguredDoctors() {
  return [
    { number: config.gupshup.sendTo, name: config.gupshup.primaryDoctorName, messageIdField: 'gupshup_message_id' },
    { number: config.gupshup.sendToSecondary, name: config.gupshup.secondaryDoctorName, messageIdField: 'secondary_gupshup_message_id' },
    { number: config.gupshup.sendToTertiary, name: config.gupshup.tertiaryDoctorName, messageIdField: 'tertiary_gupshup_message_id' },
    { number: config.gupshup.sendToQuaternary, name: config.gupshup.quaternaryDoctorName, messageIdField: 'quaternary_gupshup_message_id' },
  ].filter((doctor) => doctor.number);
}

// Whichever doctor's number a reply came in on, every other configured
// doctor needs to know it's already been handled so they don't act on a
// stale request.
async function notifyOtherDoctors(reply, updated, status, productsText) {
  const doctors = getConfiguredDoctors();
  const respondingDoctor = doctors.find((doctor) => updated[doctor.messageIdField] === reply.originalMessageId);

  // Once GUPSHUP_DOCTOR_STATUS_TEMPLATE_ID is approved and set, this switches
  // to naming which doctor responded instead of reusing the customer-facing
  // template with the product list. Approved template (prescription_doctor_status_notify)
  // takes exactly 3 variables: {1: customer name, 2: responding doctor's name, 3: status}.
  const useDoctorTemplate = Boolean(config.gupshup.doctorStatusTemplateId);

  const otherDoctors = doctors.filter((doctor) => !respondingDoctor || doctor.number !== respondingDoctor.number);

  for (const doctor of otherDoctors) {
    try {
      await gupshupService.sendStatusTemplateMessage({
        to: doctor.number,
        templateId: useDoctorTemplate ? config.gupshup.doctorStatusTemplateId : undefined,
        contentVariables: useDoctorTemplate
          ? {
              1: updated.customer_name,
              2: respondingDoctor?.name || 'the other doctor',
              3: STATUS_LABEL[status],
            }
          : {
              1: updated.customer_name,
              2: productsText || 'a prescription request',
              3: STATUS_LABEL[status],
            },
      });
    } catch (notifyErr) {
      logger.error('Failed to notify other doctor of status update', {
        error: notifyErr.message,
        id: updated.id,
        doctor: doctor.number,
      });
    }
  }
}

/**
 * Best-effort Shopify-side actions once a doctor has responded — feature
 * flagged (config.shopify.rxOrderHoldActionsEnabled, default off) and only
 * runs for requests carrying a shopify_order_gid (i.e. created via the
 * orders/create webhook path, the only path that captures it). Runs last, so
 * a Shopify API failure here never blocks or delays the doctor/customer
 * WhatsApp notifications that already went out.
 */
async function applyOrderResolutionSideEffects(updated, status) {
  if (!config.shopify.rxOrderHoldActionsEnabled || !updated.shopify_order_gid) return;

  try {
    if (status === 'approved') {
      await shopifyOrderEditService.clearRxOrderMetafield(updated.shopify_order_gid);
      await shopifyOrderEditService.removeOrderTag(updated.shopify_order_gid, config.shopify.rxTagName);
    } else if (status === 'rejected') {
      const rxItems = (updated.products || []).filter((product) => product.variant_id);
      for (const item of rxItems) {
        await shopifyOrderEditService.holdOrderLineItem(updated.shopify_order_gid, item.variant_id, item.sku);
      }
      await shopifyOrderEditService.clearRxOrderMetafield(updated.shopify_order_gid);
      await shopifyOrderEditService.removeOrderTag(updated.shopify_order_gid, config.shopify.rxTagName);
    }
  } catch (err) {
    logger.error('Failed to apply Shopify order side effects after doctor decision', {
      error: err.message,
      details: err.details,
      id: updated.id,
      status,
      shopifyOrderGid: updated.shopify_order_gid,
    });
  }
}

async function logUnmatchedReply(reply) {
  const existing = await findByMessageId(reply.originalMessageId);
  if (existing) {
    logger.info('Button reply received for a request already resolved by another doctor, ignoring', {
      id: existing.id,
      status: existing.status,
      gupshupMessageId: reply.originalMessageId,
    });
  } else {
    logger.warn('Button reply received but no matching prescription request found', {
      gupshupMessageId: reply.originalMessageId,
    });
  }
}

async function handleWebhook(req, res) {
  logger.info('Gupshup webhook payload received', { body: req.body });

  try {
    const reply = extractButtonReply(req.body);
    if (reply) {
      const updated = await updateStatusByMessageId(reply.originalMessageId, reply.status);
      if (updated) {
        logger.info('Prescription request status updated', {
          id: updated.id,
          status: reply.status,
          gupshupMessageId: reply.originalMessageId,
        });

        const productsText = summarizeProducts(updated.products);
        await notifyCustomer(updated, reply.status, productsText);
        await notifyOtherDoctors(reply, updated, reply.status, productsText);
        await applyOrderResolutionSideEffects(updated, reply.status);
      } else {
        await logUnmatchedReply(reply);
      }
    }
  } catch (err) {
    // Gupshup expects a 200 regardless — log and move on rather than making
    // Gupshup retry a webhook we can't process anyway.
    logger.error('Failed to process Gupshup webhook', { error: err.message });
  }

  res.status(200).json({ success: true });
}

module.exports = { handleWebhook };
