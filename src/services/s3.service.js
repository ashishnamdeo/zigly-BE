const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { config } = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

// No explicit credentials — picked up automatically from the Lambda
// execution role (or local AWS config/env when running outside Lambda).
const s3Client = new S3Client({ region: config.s3.region });

/**
 * Uploads a file to S3 and returns its public HTTPS URL so Gupshup can fetch
 * it. Requires the bucket to allow public s3:GetObject (see bucket policy).
 */
async function uploadPrescriptionFile({ buffer, filename, mimeType }) {
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: filename,
        Body: buffer,
        ContentType: mimeType,
      }),
    );

    return `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${filename}`;
  } catch (err) {
    logger.error('S3 file upload failed', { error: err.message });
    throw new ApiError(502, 'Failed to upload prescription file to S3', { message: err.message });
  }
}

module.exports = { uploadPrescriptionFile };
