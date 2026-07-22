const logger = require('../utils/logger');
const { updateStatusByMessageId } = require('../repositories/prescriptionRequest.repository');

const BUTTON_TO_STATUS = {
  approve: 'approved',
  reject: 'rejected',
};

/**
 * Gupshup's exact webhook shape for a button-reply hasn't been verified
 * against a live payload yet (no button click has hit this endpoint so far).
 * This defensively checks the field names Gupshup's docs describe
 * (payload.type === 'button_reply', payload.payload.title, and the original
 * outbound message id under payload.context) — adjust once a real payload
 * is captured in CloudWatch logs if the shape differs.
 */
function extractButtonReply(body) {
  const payload = body?.payload;
  if (!payload || payload.type !== 'button_reply') return null;

  const buttonText = payload.payload?.title || payload.payload?.postbackText;
  const originalMessageId = payload.context?.id || payload.context?.gsId;
  if (!buttonText || !originalMessageId) return null;

  const status = BUTTON_TO_STATUS[buttonText.trim().toLowerCase()];
  if (!status) return null;

  return { status, originalMessageId };
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
