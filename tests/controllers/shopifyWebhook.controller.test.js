const crypto = require('crypto');

const WEBHOOK_SECRET = 'test-webhook-secret';

jest.mock('../../src/config/env', () => ({
  config: {
    shopifyWebhookSecret: 'test-webhook-secret',
    shopify: { orderOriginAllowlist: '' },
  },
}));
jest.mock('../../src/services/gupshup.service');
jest.mock('../../src/repositories/prescriptionRequest.repository');
jest.mock('../../src/repositories/pendingPrescriptionUpload.repository');
jest.mock('../../src/utils/logger');
jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));

const gupshupService = require('../../src/services/gupshup.service');
const { createPrescriptionRequest, existsByShopifyOrderId } = require('../../src/repositories/prescriptionRequest.repository');
const { consumePendingUpload } = require('../../src/repositories/pendingPrescriptionUpload.repository');
const logger = require('../../src/utils/logger');
const { handleOrderCreate } = require('../../src/controllers/shopifyWebhook.controller');

function signedRequest(order, { secret = WEBHOOK_SECRET, tamperAfterSigning = false } = {}) {
  const rawBody = Buffer.from(JSON.stringify(order));
  const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return {
    get: (header) => (header === 'X-Shopify-Hmac-Sha256' ? hmac : undefined),
    rawBody: tamperAfterSigning ? Buffer.from(rawBody.toString() + 'x') : rawBody,
    body: order,
  };
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function rxOrder(overrides = {}) {
  return {
    id: 555,
    name: '#ZG1001',
    phone: '+919999999999',
    shipping_address: { first_name: 'Jane', last_name: 'Doe' },
    line_items: [
      {
        product_id: 111,
        title: 'Amoxicillin',
        quantity: 2,
        properties: [{ name: '_requires_prescription', value: 'true' }],
      },
    ],
    note_attributes: [],
    ...overrides,
  };
}

beforeEach(() => {
  existsByShopifyOrderId.mockResolvedValue(false);
  gupshupService.sendTemplateMessageToDoctors.mockResolvedValue({
    primaryMessageId: 'primary-id',
    secondaryMessageId: null,
    tertiaryMessageId: null,
  });
  createPrescriptionRequest.mockResolvedValue(1);
});

it('rejects with 401 when the HMAC signature does not match', async () => {
  const req = signedRequest(rxOrder(), { tamperAfterSigning: true });
  const res = mockRes();

  await handleOrderCreate(req, res);

  expect(res.status).toHaveBeenCalledWith(401);
  expect(existsByShopifyOrderId).not.toHaveBeenCalled();
});

it('rejects with 401 when the webhook secret is not configured', async () => {
  const { config } = require('../../src/config/env');
  config.shopifyWebhookSecret = undefined;

  const req = signedRequest(rxOrder());
  const res = mockRes();
  await handleOrderCreate(req, res);

  expect(res.status).toHaveBeenCalledWith(401);
  config.shopifyWebhookSecret = WEBHOOK_SECRET;
});

it('acks 200 without any side effects when the order has no Rx line items', async () => {
  const order = rxOrder({
    line_items: [{ product_id: 1, title: 'Shampoo', quantity: 1, properties: [] }],
  });
  const res = mockRes();

  await handleOrderCreate(signedRequest(order), res);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(existsByShopifyOrderId).not.toHaveBeenCalled();
  expect(gupshupService.sendTemplateMessageToDoctors).not.toHaveBeenCalled();
});

describe('order origin allowlist (SHOPIFY_ORDER_ORIGIN_ALLOWLIST)', () => {
  afterEach(() => {
    const { config } = require('../../src/config/env');
    config.shopify.orderOriginAllowlist = '';
  });

  it('skips processing entirely for an order whose landing_page_url does not match the allowlist', async () => {
    const { config } = require('../../src/config/env');
    config.shopify.orderOriginAllowlist = '.shopifypreview.com';

    const order = rxOrder({
      note_attributes: [{ name: 'landing_page_url', value: 'https://zigly.com/' }],
    });
    const res = mockRes();

    await handleOrderCreate(signedRequest(order), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(existsByShopifyOrderId).not.toHaveBeenCalled();
    expect(gupshupService.sendTemplateMessageToDoctors).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping orders/create webhook: order origin not in the test allowlist',
      expect.objectContaining({ landingPageUrl: 'https://zigly.com/' }),
    );
  });

  it('processes an order whose landing_page_url matches the allowlist', async () => {
    const { config } = require('../../src/config/env');
    config.shopify.orderOriginAllowlist = '.shopifypreview.com';

    const order = rxOrder({
      note_attributes: [{ name: 'landing_page_url', value: 'https://abc123-92312043836.shopifypreview.com/' }],
    });
    const res = mockRes();

    await handleOrderCreate(signedRequest(order), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(gupshupService.sendTemplateMessageToDoctors).toHaveBeenCalled();
  });

  it('processes every order when the allowlist is empty (going-live setting)', async () => {
    const { config } = require('../../src/config/env');
    config.shopify.orderOriginAllowlist = '';

    const order = rxOrder({ note_attributes: [{ name: 'landing_page_url', value: 'https://zigly.com/' }] });
    const res = mockRes();

    await handleOrderCreate(signedRequest(order), res);

    expect(gupshupService.sendTemplateMessageToDoctors).toHaveBeenCalled();
  });
});

it('sends a consult-method WhatsApp template and persists the request for a new Rx order', async () => {
  const res = mockRes();

  await handleOrderCreate(signedRequest(rxOrder()), res);

  expect(existsByShopifyOrderId).toHaveBeenCalledWith('#ZG1001');
  expect(gupshupService.sendTemplateMessageToDoctors).toHaveBeenCalledWith({
    contentVariables: { 1: 'Jane Doe', 2: '+919999999999', 3: 'Amoxicillin (x2)' },
    headerImageUrl: 'https://zigly.com/cdn/shop/files/1920X360_vetfirst_banner.png?v=1776228816&width=2000',
  });
  expect(createPrescriptionRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      gupshupMessageId: 'primary-id',
      customerName: 'Jane Doe',
      customerPhone: '+919999999999',
      method: 'consult',
      fileUrl: null,
      shopifyOrderId: '#ZG1001',
    }),
  );
  expect(res.status).toHaveBeenCalledWith(200);
});

it('falls back to order.id when order.name is absent', async () => {
  const order = rxOrder({ name: undefined });
  await handleOrderCreate(signedRequest(order), mockRes());

  expect(existsByShopifyOrderId).toHaveBeenCalledWith('555');
});

it('skips duplicate deliveries for an order already recorded', async () => {
  existsByShopifyOrderId.mockResolvedValue(true);
  const res = mockRes();

  await handleOrderCreate(signedRequest(rxOrder()), res);

  expect(gupshupService.sendTemplateMessageToDoctors).not.toHaveBeenCalled();
  expect(createPrescriptionRequest).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
});

it('logs an error and does not send when the order has no phone anywhere', async () => {
  const order = rxOrder({ phone: undefined, shipping_address: {}, billing_address: {}, customer: {} });
  const res = mockRes();

  await handleOrderCreate(signedRequest(order), res);

  expect(gupshupService.sendTemplateMessageToDoctors).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith(
    'orders/create webhook has Rx line items but no phone on the order',
    { shopifyOrderId: '#ZG1001' },
  );
  expect(res.status).toHaveBeenCalledWith(200);
});

it('resolves customer name/phone from the customer object when shipping/billing addresses are absent', async () => {
  const order = rxOrder({
    shipping_address: undefined,
    billing_address: undefined,
    phone: undefined,
    customer: { first_name: 'Alex', last_name: 'Kim', phone: '+917777777777' },
  });

  await handleOrderCreate(signedRequest(order), mockRes());

  expect(gupshupService.sendTemplateMessageToDoctors).toHaveBeenCalledWith(
    expect.objectContaining({ contentVariables: { 1: 'Alex Kim', 2: '+917777777777', 3: 'Amoxicillin (x2)' } }),
  );
});

it('defaults the customer name to "Customer" when no name is present at all', async () => {
  const order = rxOrder({ shipping_address: {}, customer: {} });

  await handleOrderCreate(signedRequest(order), mockRes());

  expect(gupshupService.sendTemplateMessageToDoctors).toHaveBeenCalledWith(
    expect.objectContaining({ contentVariables: { 1: 'Customer', 2: '+919999999999', 3: 'Amoxicillin (x2)' } }),
  );
});

describe('staged prescription upload via prescription_upload_key note attribute', () => {
  it('uses the staged file as the header image and records method "upload"', async () => {
    consumePendingUpload.mockResolvedValue('https://s3.example.com/staged-rx.png');
    const order = rxOrder({ note_attributes: [{ name: 'prescription_upload_key', value: 'key-123' }] });

    await handleOrderCreate(signedRequest(order), mockRes());

    expect(consumePendingUpload).toHaveBeenCalledWith('key-123');
    expect(gupshupService.sendTemplateMessageToDoctors).toHaveBeenCalledWith(
      expect.objectContaining({ headerImageUrl: 'https://s3.example.com/staged-rx.png' }),
    );
    expect(createPrescriptionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'upload', fileUrl: 'https://s3.example.com/staged-rx.png' }),
    );
  });

  it('falls back to consult method and logs a warning when the staged key has no matching upload', async () => {
    consumePendingUpload.mockResolvedValue(null);
    const order = rxOrder({ note_attributes: [{ name: 'prescription_upload_key', value: 'stale-key' }] });

    await handleOrderCreate(signedRequest(order), mockRes());

    expect(logger.warn).toHaveBeenCalledWith(
      'orders/create webhook had a prescription_upload_key with no matching staged upload',
      { shopifyOrderId: '#ZG1001', uploadKey: 'stale-key' },
    );
    expect(createPrescriptionRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'consult', fileUrl: null }));
  });
});

it('still responds 200 when persisting the request fails after the WhatsApp send succeeds', async () => {
  createPrescriptionRequest.mockRejectedValue(new Error('db down'));
  const res = mockRes();

  await handleOrderCreate(signedRequest(rxOrder()), res);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ success: true });
});

it('still responds 200 when an unexpected error is thrown mid-processing', async () => {
  gupshupService.sendTemplateMessageToDoctors.mockRejectedValue(new Error('gupshup exploded'));
  const res = mockRes();

  await handleOrderCreate(signedRequest(rxOrder()), res);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ success: true });
  expect(logger.error).toHaveBeenCalledWith(
    'Failed to process orders/create webhook',
    expect.objectContaining({ error: 'gupshup exploded' }),
  );
});
