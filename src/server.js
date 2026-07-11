const fs = require('fs');
const path = require('path');

const { config, validateConfig } = require('./config/env');
const logger = require('./utils/logger');

try {
  validateConfig();
} catch (err) {
  logger.error(err.message);
  process.exit(1);
}

const uploadPath = path.join(process.cwd(), config.uploadDir);
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

const app = require('./app');

const server = app.listen(config.port, () => {
  logger.info(`Server listening on port ${config.port}`, { env: config.nodeEnv });
});

function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason?.message || reason });
});
