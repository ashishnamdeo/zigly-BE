const multer = require('multer');
const fs = require('fs/promises');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/** Removes an uploaded file from disk if a later step in the request fails. */
async function cleanupUploadedFile(req) {
  if (req.file?.path) {
    try {
      await fs.unlink(req.file.path);
    } catch (err) {
      logger.warn('Failed to clean up uploaded file', { path: req.file.path, error: err.message });
    }
  }
}

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: 'Route not found' });
}

// eslint-disable-next-line no-unused-vars
async function errorHandler(err, req, res, next) {
  await cleanupUploadedFile(req);

  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the maximum allowed size' : err.message;
    return res.status(400).json({ success: false, message });
  }

  const statusCode = err instanceof ApiError ? err.statusCode : 500;
  const message = err.isOperational ? err.message : 'Internal server error';

  logger.error(err.message, { statusCode, stack: err.stack, details: err.details });

  res.status(statusCode).json({
    success: false,
    message,
    ...(err.details ? { details: err.details } : {}),
  });
}

module.exports = { errorHandler, notFoundHandler, cleanupUploadedFile };
