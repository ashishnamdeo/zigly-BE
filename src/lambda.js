const serverlessHttp = require('serverless-http');
const app = require('./app');
const handleEscalationCheck = require('./handlers/escalationChecker.handler');

// API Gateway forwards the stage name and the Lambda's own route prefix as
// part of the path (e.g. "/default/zigly-prescription-upload/health"), but
// Express routes are defined relative to the app root (e.g. "/health").
const ROUTE_PREFIX = '/zigly-prescription-upload';

const httpHandler = serverlessHttp(app);

module.exports.handler = (event, context) => {
  // EventBridge Scheduler invokes this Lambda directly (no API Gateway
  // envelope at all) with the payload set as escalationScheduler.service.js
  // built it — recognized by its own "source" marker rather than by the
  // absence of an HTTP shape, so it can never be confused with a real request.
  if (event && event.source === 'zigly.escalation-checker') {
    return handleEscalationCheck(event);
  }

  if (typeof event.rawPath === 'string') {
    const stageStripped = event.rawPath.replace(/^\/[^/]+/, '');
    const prefixIndex = stageStripped.indexOf(ROUTE_PREFIX);
    if (prefixIndex === 0) {
      event.rawPath = stageStripped.slice(ROUTE_PREFIX.length) || '/';
    }
  }
  if (event.requestContext?.http?.path) {
    const stageStripped = event.requestContext.http.path.replace(/^\/[^/]+/, '');
    const prefixIndex = stageStripped.indexOf(ROUTE_PREFIX);
    if (prefixIndex === 0) {
      event.requestContext.http.path = stageStripped.slice(ROUTE_PREFIX.length) || '/';
    }
  }
  return httpHandler(event, context);
};
