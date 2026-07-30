jest.mock('../../src/config/env', () => ({
  config: {
    maxFileSizeMb: 10,
    s3: { bucket: 'test-bucket', region: 'ap-south-1' },
    db: { host: 'localhost', port: 5432, database: 'test', user: 'test', password: 'test' },
  },
}));
jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
jest.mock('../../src/services/gupshup.service');
jest.mock('../../src/services/s3.service');
jest.mock('../../src/repositories/prescriptionRequest.repository');
jest.mock('../../src/repositories/pendingPrescriptionUpload.repository');
jest.mock('../../src/utils/logger');

const express = require('express');
const request = require('supertest');

const gupshupService = require('../../src/services/gupshup.service');
const s3Service = require('../../src/services/s3.service');
const {
  createPrescriptionRequest,
  findRecentByPhone,
  existsByShopifyOrderId,
} = require('../../src/repositories/prescriptionRequest.repository');
const { createPendingUpload } = require('../../src/repositories/pendingPrescriptionUpload.repository');
const prescriptionRoutes = require('../../src/routes/prescription.routes');
const { errorHandler, notFoundHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/prescription', prescriptionRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

const DEFAULT_SEND_RESULT = {
  primaryMessageId: 'primary-id',
  secondaryMessageId: 'secondary-id',
  tertiaryMessageId: null,
};

beforeEach(() => {
  gupshupService.sendTemplateMessageToDoctors.mockResolvedValue(DEFAULT_SEND_RESULT);
  s3Service.uploadPrescriptionFile.mockResolvedValue('https://s3.example.com/rx.png');
  createPrescriptionRequest.mockResolvedValue(1);
  createPendingUpload.mockResolvedValue();
  existsByShopifyOrderId.mockResolvedValue(false);
  findRecentByPhone.mockResolvedValue([]);
});

describe('POST /api/prescription/upload', () => {
  it('uploads the file to S3, forwards to WhatsApp, and persists the request', async () => {
    const res = await request(app)
      .post('/api/prescription/upload')
      .field('name', 'Jane Doe')
      .field('phone', '+919999999999')
      .field('products', JSON.stringify([{ title: 'Amoxicillin', quantity: 2 }]))
      .attach('prescription', Buffer.from('fake-image-bytes'), { filename: 'rx.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Prescription uploaded and sent via WhatsApp successfully',
      imageUrl: 'https://s3.example.com/rx.png',
    });

    expect(gupshupService.sendTemplateMessageToDoctors).toHaveBeenCalledWith({
      contentVariables: { 1: 'Jane Doe', 2: '+919999999999', 3: 'Amoxicillin (x2)' },
      headerImageUrl: 'https://s3.example.com/rx.png',
    });

    expect(createPrescriptionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gupshupMessageId: 'primary-id',
        secondaryGupshupMessageId: 'secondary-id',
        tertiaryGupshupMessageId: null,
        customerName: 'Jane Doe',
        customerPhone: '+919999999999',
        method: 'upload',
        fileUrl: 'https://s3.example.com/rx.png',
      }),
    );
  });

  it('rejects a missing name with 400', async () => {
    const res = await request(app)
      .post('/api/prescription/upload')
      .field('phone', '+919999999999')
      .attach('prescription', Buffer.from('x'), { filename: 'rx.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Customer name is required/);
    expect(s3Service.uploadPrescriptionFile).not.toHaveBeenCalled();
  });

  it('rejects an invalid phone with 400', async () => {
    const res = await request(app)
      .post('/api/prescription/upload')
      .field('name', 'Jane Doe')
      .field('phone', 'not-a-phone')
      .attach('prescription', Buffer.from('x'), { filename: 'rx.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid phone number/);
  });

  it('rejects a missing file with 400', async () => {
    const res = await request(app)
      .post('/api/prescription/upload')
      .field('name', 'Jane Doe')
      .field('phone', '+919999999999');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/prescription file/);
  });

  it('rejects disallowed file types with 400', async () => {
    const res = await request(app)
      .post('/api/prescription/upload')
      .field('name', 'Jane Doe')
      .field('phone', '+919999999999')
      .attach('prescription', Buffer.from('x'), { filename: 'rx.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only JPG, PNG, or PDF/);
  });

  it('still responds 200 if persisting the request fails after WhatsApp send succeeds', async () => {
    createPrescriptionRequest.mockRejectedValue(new Error('db down'));

    const res = await request(app)
      .post('/api/prescription/upload')
      .field('name', 'Jane Doe')
      .field('phone', '+919999999999')
      .attach('prescription', Buffer.from('x'), { filename: 'rx.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/prescription/consult', () => {
  it('sends a consultation request and persists it', async () => {
    const res = await request(app)
      .post('/api/prescription/consult')
      .send({ name: 'Jane Doe', phone: '+919999999999', products: JSON.stringify([{ title: 'Vitamin C' }]) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Consultation request sent via WhatsApp successfully' });
    expect(gupshupService.sendTemplateMessageToDoctors).toHaveBeenCalledWith(
      expect.objectContaining({ contentVariables: { 1: 'Jane Doe', 2: '+919999999999', 3: 'Vitamin C' } }),
    );
    expect(createPrescriptionRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'consult', fileUrl: null }));
  });

  it('rejects a missing phone with 400', async () => {
    const res = await request(app).post('/api/prescription/consult').send({ name: 'Jane Doe' });
    expect(res.status).toBe(400);
  });

  it('propagates a Gupshup failure as a 502', async () => {
    const ApiError = require('../../src/utils/ApiError');
    gupshupService.sendTemplateMessageToDoctors.mockRejectedValue(new ApiError(502, 'Failed to send WhatsApp template message via Gupshup'));

    const res = await request(app)
      .post('/api/prescription/consult')
      .send({ name: 'Jane Doe', phone: '+919999999999' });

    expect(res.status).toBe(502);
    expect(createPrescriptionRequest).not.toHaveBeenCalled();
  });
});

describe('POST /api/prescription/status', () => {
  it('returns the most recent status per requested product id', async () => {
    findRecentByPhone.mockResolvedValue([
      {
        products: [{ product_id: 111 }],
        status: 'approved',
        created_at: '2026-01-02T00:00:00.000Z',
        responded_at: '2026-01-02T01:00:00.000Z',
      },
      {
        products: [{ product_id: 111 }],
        status: 'pending',
        created_at: '2026-01-01T00:00:00.000Z',
        responded_at: null,
      },
    ]);

    const res = await request(app)
      .post('/api/prescription/status')
      .send({ phone: '+919999999999', productIds: [111, 222] });

    expect(res.status).toBe(200);
    expect(res.body.statuses).toEqual({
      '111': { status: 'approved', createdAt: '2026-01-02T00:00:00.000Z', respondedAt: '2026-01-02T01:00:00.000Z' },
    });
    expect(res.body.statuses['222']).toBeUndefined();
  });

  it('rejects an empty productIds array with 400', async () => {
    const res = await request(app).post('/api/prescription/status').send({ phone: '+919999999999', productIds: [] });
    expect(res.status).toBe(400);
  });

  it('rejects non-numeric product ids with 400', async () => {
    const res = await request(app)
      .post('/api/prescription/status')
      .send({ phone: '+919999999999', productIds: ['abc'] });
    expect(res.status).toBe(400);
  });

  it('rejects more than 100 product ids with 400', async () => {
    const res = await request(app)
      .post('/api/prescription/status')
      .send({ phone: '+919999999999', productIds: Array.from({ length: 101 }, (_, i) => i) });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/prescription/auto-consult', () => {
  it('sends and persists when the order has not already been handled', async () => {
    const res = await request(app)
      .post('/api/prescription/auto-consult')
      .send({ name: 'Jane Doe', phone: '+919999999999', orderId: '#1001', products: [{ title: 'Vitamin C' }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, name: 'Jane Doe', phone: '+919999999999' });
    expect(gupshupService.sendTemplateMessageToDoctors).toHaveBeenCalledTimes(1);
    expect(createPrescriptionRequest).toHaveBeenCalledWith(expect.objectContaining({ shopifyOrderId: '#1001' }));
  });

  it('skips sending when the orders/create webhook already handled this order', async () => {
    existsByShopifyOrderId.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/prescription/auto-consult')
      .send({ name: 'Jane Doe', phone: '+919999999999', orderId: '#1001', products: [{ title: 'Vitamin C' }] });

    expect(res.status).toBe(200);
    expect(gupshupService.sendTemplateMessageToDoctors).not.toHaveBeenCalled();
    expect(createPrescriptionRequest).not.toHaveBeenCalled();
  });

  it('rejects a missing products array with 400', async () => {
    const res = await request(app)
      .post('/api/prescription/auto-consult')
      .send({ name: 'Jane Doe', phone: '+919999999999' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/prescription/auto-upload', () => {
  it('skips the S3 upload entirely when the order was already handled', async () => {
    existsByShopifyOrderId.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/prescription/auto-upload')
      .field('name', 'Jane Doe')
      .field('phone', '+919999999999')
      .field('orderId', '#1001')
      .attach('prescription', Buffer.from('x'), { filename: 'rx.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(s3Service.uploadPrescriptionFile).not.toHaveBeenCalled();
    expect(gupshupService.sendTemplateMessageToDoctors).not.toHaveBeenCalled();
  });

  it('uploads and persists with the shopifyOrderId when the order is new', async () => {
    const res = await request(app)
      .post('/api/prescription/auto-upload')
      .field('name', 'Jane Doe')
      .field('phone', '+919999999999')
      .field('orderId', '#1002')
      .attach('prescription', Buffer.from('x'), { filename: 'rx.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(createPrescriptionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'upload', shopifyOrderId: '#1002' }),
    );
  });
});

describe('POST /api/prescription/stage-upload', () => {
  it('uploads to S3 and stores a pending upload keyed by a generated uuid', async () => {
    const res = await request(app)
      .post('/api/prescription/stage-upload')
      .attach('prescription', Buffer.from('x'), { filename: 'rx.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.key).toBe('string');
    expect(createPendingUpload).toHaveBeenCalledWith({
      key: res.body.key,
      fileUrl: 'https://s3.example.com/rx.png',
    });
  });

  it('rejects a missing file with 400', async () => {
    const res = await request(app).post('/api/prescription/stage-upload');
    expect(res.status).toBe(400);
    expect(createPendingUpload).not.toHaveBeenCalled();
  });
});
