const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { config } = require('./config/env');
const prescriptionRoutes = require('./routes/prescription.routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const gupshupWebhookController = require('./controllers/gupshupWebhook.controller');
const shopifyWebhookController = require('./controllers/shopifyWebhook.controller');

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
// The `verify` callback stashes the exact raw bytes Shopify signed, since
// verifying its HMAC signature against a re-serialized JSON.stringify(body)
// can fail on byte-for-byte differences (key order, whitespace, etc.).
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => res.status(200).json({ success: true, status: 'ok' }));

app.post('/api/gupshup/webhook', gupshupWebhookController.handleWebhook);
app.post('/webhooks/orders-create', shopifyWebhookController.handleOrderCreate);

app.use('/api/prescription', prescriptionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
