const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const { config } = require('./config/env');
const prescriptionRoutes = require('./routes/prescription.routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

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

app.use('/api/prescription', prescriptionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
