const express = require('express');
const rateLimit = require('express-rate-limit');
const { upload } = require('../middleware/upload.middleware');
const {
  uploadPrescription,
  requestConsultation,
  getPrescriptionStatus,
  autoConsultFromOrder,
  autoUploadFromOrder,
  stagePrescriptionUpload,
} = require('../controllers/prescription.controller');

const router = express.Router();

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many uploads from this IP, please try again later' },
});

const statusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests from this IP, please try again later' },
});

router.post('/upload', uploadLimiter, upload.single('prescription'), uploadPrescription);
router.post('/consult', uploadLimiter, requestConsultation);
router.post('/status', statusLimiter, getPrescriptionStatus);
router.post('/auto-consult', uploadLimiter, autoConsultFromOrder);
router.post('/auto-upload', uploadLimiter, upload.single('prescription'), autoUploadFromOrder);
router.post('/stage-upload', uploadLimiter, upload.single('prescription'), stagePrescriptionUpload);

module.exports = router;
