const logger = require('../utils/logger');
const doctorApprovalFlow = require('../services/doctorApprovalFlow.service');

// Invoked directly by EventBridge Scheduler (not through API Gateway/Express)
// — see lambda.js's dispatch and escalationScheduler.service.js's Target.
// Throwing lets Lambda's own async-invoke retry policy retry a transient
// failure (e.g. a DB blip); escalate() itself is a safe CAS no-op if the
// request was already resolved by the time this runs.
module.exports = async function handleEscalationCheck(event) {
  const { requestId, slot } = event;
  const result = await doctorApprovalFlow.escalate({ requestId, slot });
  logger.info('Escalation check processed', { requestId, slot, outcome: result.outcome });
  return result;
};
