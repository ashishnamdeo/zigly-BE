const express = require('express');
const rateLimit = require('express-rate-limit');
const { upload } = require('../middleware/upload.middleware');
const { uploadPrescription, requestConsultation } = require('../controllers/prescription.controller');

const router = express.Router();

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many uploads from this IP, please try again later' },
});

router.post('/upload', uploadLimiter, upload.single('prescription'), uploadPrescription);
router.post('/consult', uploadLimiter, requestConsultation);

module.exports = router;
