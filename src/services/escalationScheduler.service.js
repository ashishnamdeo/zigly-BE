const { SchedulerClient, CreateScheduleCommand } = require('@aws-sdk/client-scheduler');
const { config } = require('../config/env');
const logger = require('../utils/logger');

let client;
function getClient() {
  if (!client) client = new SchedulerClient({ region: config.escalation.region });
  return client;
}

// EventBridge Scheduler's at() expression wants local time with no
// milliseconds/timezone suffix; ScheduleExpressionTimezone below is what
// actually pins it to UTC.
function isoSecondsFromNow(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, '');
}

/**
 * Schedules a one-time check, `delaySeconds` from now, that re-invokes this
 * same Lambda to see whether `slot` ever replied — see escalationChecker
 * handler and doctorApprovalFlow.service.js#escalate. ActionAfterCompletion
 * DELETE means the schedule cleans itself up once it fires; there's no need
 * to cancel it if the doctor replies first, since escalate() is a no-op CAS
 * when it finds the request has already moved on.
 */
async function scheduleEscalationCheck({ requestId, slot, delaySeconds }) {
  if (!config.escalation.lambdaFunctionArn || !config.escalation.schedulerRoleArn) {
    throw new Error('ESCALATION_LAMBDA_ARN / ESCALATION_SCHEDULER_ROLE_ARN not configured');
  }

  // EventBridge Scheduler schedule names allow only [0-9a-zA-Z-_], max 64 chars.
  const name = `rx-escalate-${requestId}-${slot}`.slice(0, 64);

  await getClient().send(
    new CreateScheduleCommand({
      Name: name,
      ScheduleExpression: `at(${isoSecondsFromNow(delaySeconds)})`,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: {
        Arn: config.escalation.lambdaFunctionArn,
        RoleArn: config.escalation.schedulerRoleArn,
        Input: JSON.stringify({ source: 'zigly.escalation-checker', requestId, slot }),
      },
    }),
  );

  logger.info('Scheduled escalation check', { requestId, slot, delaySeconds });
}

module.exports = { scheduleEscalationCheck };
