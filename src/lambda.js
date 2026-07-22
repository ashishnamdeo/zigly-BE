const serverlessHttp = require('serverless-http');
const app = require('./app');

// API Gateway forwards the stage name and the Lambda's own route prefix as
// part of the path (e.g. "/default/zigly-prescription-upload/health"), but
// Express routes are defined relative to the app root (e.g. "/health").
const ROUTE_PREFIX = '/zigly-prescription-upload';

const httpHandler = serverlessHttp(app);

module.exports.handler = (event, context) => {
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
