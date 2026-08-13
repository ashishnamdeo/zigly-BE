const logger = require('../utils/logger');
const gupshupService = require('./gupshup.service');
const schedulerService = require('./escalationScheduler.service');
const doctorRoster = require('./doctorRoster');
const { config } = require('../config/env');
const repo = require('../repositories/prescriptionRequest.repository');

// Generic banner used as the template image header when there's no
// prescription photo to show (consult requests, and any doctor a request
// escalates to after the first one — the header has to be re-sent each time
// since it's not something WhatsApp keeps attached to the underlying request).
const CONSULT_HEADER_IMAGE_URL = 'https://zigly.com/cdn/shop/files/1920X360_vetfirst_banner.png?v=1776228816&width=2000';

function statusForSlot(slot) {
  return `pending_${slot}`;
}

// Consult requests ("no prescription uploaded, doctor will call") use their
// own approved template — different copy than the upload template, which
// assumes a photo is attached. Falls back to the upload template if the
// consult one isn't configured yet, so nothing breaks mid-rollout.
function templateIdForMethod(method) {
  if (method === 'consult') return config.gupshup.consultTemplateId || config.gupshup.templateId;
  return config.gupshup.templateId;
}

// The dedicated consult template's header component is TEXT, not IMAGE (unlike
// the upload template, whose header is the prescription photo) — attaching
// CONSULT_HEADER_IMAGE_URL to it gets the whole send rejected by WhatsApp with
// a (#2012) header format-mismatch error. Only suppress the header when the
// consult template is actually in play; the upload-template fallback (consult
// template unconfigured) still needs its banner image.
function usesConsultTemplate(method) {
  return method === 'consult' && Boolean(config.gupshup.consultTemplateId);
}

function summarizeProducts(products) {
  return (products || [])
    .map((product) => {
      const title = product.title || 'Item';
      return product.quantity > 1 ? `${title} (x${product.quantity})` : title;
    })
    .join(', ');
}

// Sends the template to exactly one doctor, logs the attempt (even if the
// send itself failed — a failed send still needs a row so §7's audit trail
// is complete), and starts that slot's 60s escalation timer. Best-effort on
// both the send and the schedule: a failure in either is logged and the
// request is left exactly where it is rather than thrown, since there's
// nothing else useful to do with an already-created request mid-flow.
async function pageDoctor(requestId, doctor, { customerName, customerPhone, products, headerImageUrl, templateId }) {
  const contentVariables = { 1: customerName, 2: customerPhone, 3: summarizeProducts(products) };

  let messageId = null;
  try {
    const result = await gupshupService.sendTemplateMessage({
      contentVariables,
      headerImageUrl,
      destination: doctor.number,
      templateId,
    });
    messageId = result.messageId;
  } catch (err) {
    logger.error('Failed to send approval template to doctor', { error: err.message, requestId, slot: doctor.slot });
  }

  const logId = await repo.insertDoctorRequestLog({
    prescriptionRequestId: requestId,
    doctorSlot: doctor.slot,
    doctorName: doctor.name,
    doctorMobile: doctor.number,
    gupshupMessageId: messageId,
  });

  if (!messageId) {
    await repo.markDoctorLogSendFailed(logId, 'Gupshup send failed or returned no messageId');
    return;
  }

  try {
    await schedulerService.scheduleEscalationCheck({
      requestId,
      slot: doctor.slot,
      delaySeconds: config.escalation.windowSeconds,
    });
  } catch (err) {
    logger.error('Failed to schedule escalation check — this slot will not auto-escalate on timeout', {
      error: err.message,
      requestId,
      slot: doctor.slot,
    });
  }
}

/**
 * Creates the request and pages ONLY the first configured doctor slot —
 * this replaces the old all-doctors-at-once fan-out. If nothing is
 * configured at all, the request is still created (so it's not silently
 * lost) but nothing is sent; validateConfig() already requires
 * GUPSHUP_SEND_TO in practice, so this is a defensive fallback, not the
 * expected path.
 */
async function startFlow({ customerName, customerPhone, method, fileUrl, products, medicineName, shopifyOrderId, shopifyOrderGid, headerImageUrl }) {
  const doctors = doctorRoster.getConfiguredDoctors();
  const first = doctors[0];

  const requestId = await repo.createPrescriptionRequest({
    customerName,
    customerPhone,
    method,
    fileUrl,
    products,
    medicineName,
    shopifyOrderId,
    shopifyOrderGid,
    status: first ? statusForSlot(first.slot) : 'failed',
  });

  if (!first) {
    logger.error('No doctor numbers configured — request created but nobody was paged', { requestId });
    return requestId;
  }

  await pageDoctor(requestId, first, {
    customerName,
    customerPhone,
    products,
    headerImageUrl: usesConsultTemplate(method) ? null : headerImageUrl,
    templateId: templateIdForMethod(method),
  });
  return requestId;
}

/**
 * Called from the Gupshup webhook when a doctor taps Approve/Reject. Looks
 * up which request/slot this specific message id belongs to, then races the
 * same CAS transition as escalate() below.
 *
 * Returns one of:
 *   { outcome: 'unknown' }                                    — message id not recognized at all
 *   { outcome: 'resolved', request, slot }                    — this reply just resolved the request
 *   { outcome: 'late', slot, doctorName, doctorMobile, request } — first time this late reply is seen; notify the doctor
 *   { outcome: 'duplicate' }                                   — a redelivery of a reply already marked late; no-op
 */
async function resolve(gupshupMessageId, decision) {
  const log = await repo.findDoctorLogByMessageId(gupshupMessageId);
  if (!log) return { outcome: 'unknown' };

  const won = await repo.transitionRequestStatus(log.prescription_request_id, statusForSlot(log.doctor_slot), decision, {
    doctorName: log.doctor_name,
    doctorMobile: log.doctor_mobile,
  });

  if (won) {
    await repo.markDoctorLogResponded(log.log_id, decision);
    return { outcome: 'resolved', request: won, slot: log.doctor_slot };
  }

  const firstTimeLate = await repo.markDoctorLogSuperseded(log.log_id, decision);
  if (!firstTimeLate) return { outcome: 'duplicate' };

  return {
    outcome: 'late',
    slot: log.doctor_slot,
    doctorName: log.doctor_name,
    doctorMobile: log.doctor_mobile,
    request: await repo.getRequestById(log.prescription_request_id),
  };
}

// How many full primary->...->quaternary rounds to run before giving up for
// good. 2 means: if the last configured doctor times out once, page
// everyone again from the top; only if that second round also exhausts does
// the request finally become 'failed'.
const MAX_ROUNDS = 2;

/**
 * Called by the EventBridge Scheduler check, `windowSeconds` after a doctor
 * was paged. If they haven't replied, moves the chain to the next configured
 * slot. Once the last configured slot also times out, loops back to primary
 * for another round (up to MAX_ROUNDS total) before finally giving up and
 * marking the request 'failed'. Loses cleanly — 0 rows, no-op — if the
 * doctor's reply already won the race moments earlier.
 */
async function escalate({ requestId, slot }) {
  let next = doctorRoster.nextSlotAfter(slot);
  let roundsSoFar;

  if (!next) {
    roundsSoFar = await repo.countLogsForSlot(requestId, 'primary');
    if (roundsSoFar < MAX_ROUNDS) next = doctorRoster.getConfiguredDoctors()[0];
  }

  const toStatus = next ? statusForSlot(next.slot) : 'failed';

  const won = await repo.transitionRequestStatus(requestId, statusForSlot(slot), toStatus, {});
  if (!won) return { outcome: 'already-resolved' };

  const awaitingLog = await repo.findAwaitingDoctorLog(requestId, slot);
  if (awaitingLog) await repo.markDoctorLogExpired(awaitingLog.id);

  if (!next) {
    logger.error('Doctor approval chain exhausted after all retry rounds — no configured doctor responded', { requestId });
    return { outcome: 'failed' };
  }

  await pageDoctor(requestId, next, {
    customerName: won.customer_name,
    customerPhone: won.customer_phone,
    products: won.products,
    headerImageUrl: usesConsultTemplate(won.method) ? null : won.file_url || CONSULT_HEADER_IMAGE_URL,
    templateId: templateIdForMethod(won.method),
  });

  return roundsSoFar
    ? { outcome: 'escalated', to: next.slot, round: roundsSoFar + 1 }
    : { outcome: 'escalated', to: next.slot };
}

module.exports = { startFlow, resolve, escalate, statusForSlot, summarizeProducts, CONSULT_HEADER_IMAGE_URL };
