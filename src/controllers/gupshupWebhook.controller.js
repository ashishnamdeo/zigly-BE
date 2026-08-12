const { config } = require('../config/env');
const logger = require('../utils/logger');
const gupshupService = require('../services/gupshup.service');
const shopifyOrderEditService = require('../services/shopifyOrderEdit.service');
const doctorApprovalFlow = require('../services/doctorApprovalFlow.service');

const BUTTON_TO_STATUS = {
  approve: 'approved',
  reject: 'rejected',
};

const STATUS_LABEL = {
  approved: 'Approved',
  rejected: 'Rejected',
  // A late reply can land after the whole chain has already timed out with
  // nobody responding (doctorApprovalFlow.escalate's terminal 'failed'
  // state) — found by a real doctor tapping Approve ~40s after their own
  // window had already closed, which sent this label as `undefined` before.
  failed: 'closed (no doctor responded in time)',
};

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

async function notifyCustomer(request, status, productsText) {
  try {
    await gupshupService.sendStatusTemplateMessage({
      to: request.customer_phone,
      contentVariables: {
        1: request.customer_name,
        2: productsText || 'your prescription request',
        3: STATUS_LABEL[status],
      },
    });
  } catch (notifyErr) {
    logger.error('Failed to notify customer of status update', { error: notifyErr.message, id: request.id });
  }
}

/**
 * Tells a doctor who replied after the request was already resolved that
 * their reply is a no-op — e.g. Secondary was already paged and decided
 * before a slow Primary reply comes in, or any doctor double-taps their own
 * button (skipped below: nothing useful to tell someone about their own
 * decision). This is now a single doctor at most, since only one slot is
 * ever mid-flight at a time — there's no longer a whole panel to fan this
 * out to the way the old simultaneous-notify model needed.
 */
async function notifyLateDoctor({ doctorName, doctorMobile, request }) {
  if (!doctorMobile) return;

  // The doctor who actually resolved it tapping again (e.g. Approve then
  // Reject moments later) — tell them their original decision already
  // stands, rather than staying silent as if the tap did nothing.
  if (doctorMobile === request.doctor_mobile) {
    try {
      await gupshupService.sendTextMessage({
        to: doctorMobile,
        text: `You've already marked this request for ${request.customer_name} as ${STATUS_LABEL[request.status]}. That decision has already been acted on, so this tap didn't change anything.`,
      });
    } catch (notifyErr) {
      logger.error('Failed to notify doctor that their decision was already recorded', {
        error: notifyErr.message,
        id: request.id,
        doctor: doctorMobile,
      });
    }
    return;
  }

  const useDoctorTemplate = Boolean(config.gupshup.doctorStatusTemplateId);
  const productsText = doctorApprovalFlow.summarizeProducts(request.products);

  try {
    await gupshupService.sendStatusTemplateMessage({
      to: doctorMobile,
      templateId: useDoctorTemplate ? config.gupshup.doctorStatusTemplateId : undefined,
      contentVariables: useDoctorTemplate
        ? {
            1: request.customer_name,
            2: request.doctor_name || 'another doctor',
            3: STATUS_LABEL[request.status],
          }
        : {
            1: request.customer_name,
            2: productsText || 'a prescription request',
            3: STATUS_LABEL[request.status],
          },
    });
  } catch (notifyErr) {
    logger.error('Failed to notify late-replying doctor that the request was already resolved', {
      error: notifyErr.message,
      id: request.id,
      doctor: doctorMobile,
    });
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
async function applyOrderResolutionSideEffects(request, status) {
  if (!config.shopify.rxOrderHoldActionsEnabled || !request.shopify_order_gid) return;

  try {
    if (status === 'approved') {
      await shopifyOrderEditService.clearRxOrderMetafield(request.shopify_order_gid);
      await shopifyOrderEditService.removeOrderTag(request.shopify_order_gid, config.shopify.rxTagName);
    } else if (status === 'rejected') {
      const rxItems = (request.products || []).filter((product) => product.variant_id);
      for (const item of rxItems) {
        await shopifyOrderEditService.holdOrderLineItem(request.shopify_order_gid, item.variant_id, item.sku);
      }
      await shopifyOrderEditService.clearRxOrderMetafield(request.shopify_order_gid);
      await shopifyOrderEditService.removeOrderTag(request.shopify_order_gid, config.shopify.rxTagName);
    }
  } catch (err) {
    logger.error('Failed to apply Shopify order side effects after doctor decision', {
      error: err.message,
      details: err.details,
      id: request.id,
      status,
      shopifyOrderGid: request.shopify_order_gid,
    });
  }
}

async function handleWebhook(req, res) {
  logger.info('Gupshup webhook payload received', { body: req.body });

  try {
    const reply = extractButtonReply(req.body);
    if (reply) {
      const result = await doctorApprovalFlow.resolve(reply.originalMessageId, reply.status);

      if (result.outcome === 'resolved') {
        const { request, slot } = result;
        logger.info('Prescription request status updated', { id: request.id, status: reply.status, slot });

        const productsText = doctorApprovalFlow.summarizeProducts(request.products);
        await notifyCustomer(request, reply.status, productsText);
        await applyOrderResolutionSideEffects(request, reply.status);
      } else if (result.outcome === 'late') {
        logger.info('Button reply received for a request already resolved by another doctor', {
          slot: result.slot,
          gupshupMessageId: reply.originalMessageId,
        });
        await notifyLateDoctor(result);
      } else if (result.outcome === 'duplicate') {
        logger.info('Duplicate webhook delivery for an already-superseded reply, ignoring', {
          gupshupMessageId: reply.originalMessageId,
        });
      } else {
        logger.warn('Button reply received but no matching prescription request found', {
          gupshupMessageId: reply.originalMessageId,
        });
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
