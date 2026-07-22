const multer = require('multer');
const { config } = require('../config/env');
const ApiError = require('../utils/ApiError');

const ALLOWED_MIME_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/pdf': '.pdf',
};

// Files are forwarded to Shopify's CDN (see shopify.service.js) rather than
// saved locally — local disk doesn't persist or serve publicly on Lambda.
const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES[file.mimetype]) {
    cb(new ApiError(400, 'Only JPG, PNG, or PDF files are allowed'));
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.maxFileSizeMb * 1024 * 1024,
    files: 1,
  },
});

module.exports = { upload, ALLOWED_MIME_TYPES };
