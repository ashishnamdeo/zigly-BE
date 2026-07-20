const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const { config } = require('./config/env');
const prescriptionRoutes = require('./routes/prescription.routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const logger = require('./utils/logger');

const app = express();

// Railway (and most PaaS hosts) sit behind a reverse proxy that sets
// X-Forwarded-For; express-rate-limit needs this to identify clients correctly.
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(
  cors({
    origin: config.allowedOrigins.length ? config.allowedOrigins : false,
    methods: ['GET', 'POST'],
  }),
);
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serves uploaded files so Gupshup can fetch them by public URL.
app.use('/uploads', express.static(path.join(process.cwd(), config.uploadDir)));

app.get('/health', (req, res) => res.status(200).json({ success: true, status: 'ok' }));

// Temporary diagnostic endpoint: logs whatever Gupshup's webhook sends so
// delivery/failure events can be inspected via Railway's deploy logs.
app.post('/api/gupshup/webhook-debug', (req, res) => {
  logger.info('Gupshup webhook payload received', { body: req.body });
  res.status(200).json({ success: true });
});

app.use('/api/prescription', prescriptionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
