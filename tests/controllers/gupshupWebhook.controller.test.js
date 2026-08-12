jest.mock('../../src/config/env', () => ({
  config: {
    gupshup: {
      doctorStatusTemplateId: undefined,
      statusTemplateId: 'status-template-id',
    },
    shopify: {
      rxOrderHoldActionsEnabled: false,
      rxTagName: 'rx_prescription_order',
    },
  },
}));
jest.mock('../../src/services/gupshup.service');
jest.mock('../../src/services/shopifyOrderEdit.service');
jest.mock('../../src/services/doctorApprovalFlow.service', () => ({
  resolve: jest.fn(),
  // A plain re-implementation rather than requireActual — the real module
  // pulls in the repository -> db/pool chain, which would need its own
  // config.db mock just to be introspected by that require.
  summarizeProducts: (products) =>
    (products || [])
      .map((p) => (p.quantity > 1 ? `${p.title || 'Item'} (x${p.quantity})` : p.title || 'Item'))
      .join(', '),
}));
jest.mock('../../src/utils/logger');

const { config } = require('../../src/config/env');
const gupshupService = require('../../src/services/gupshup.service');
const shopifyOrderEditService = require('../../src/services/shopifyOrderEdit.service');
const doctorApprovalFlow = require('../../src/services/doctorApprovalFlow.service');
const logger = require('../../src/utils/logger');
const { handleWebhook } = require('../../src/controllers/gupshupWebhook.controller');

function buildQuickReply(buttonText, gsId) {
  return {
    type: 'message',
    payload: {
      type: 'quick_reply',
      payload: { text: buttonText },
      context: { id: 'wa-msg-id', gsId },
    },
  };
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  gupshupService.sendStatusTemplateMessage.mockResolvedValue({ messageId: 'status-msg' });
  shopifyOrderEditService.clearRxOrderMetafield.mockResolvedValue({});
  shopifyOrderEditService.holdOrderLineItem.mockResolvedValue({});
  shopifyOrderEditService.removeOrderTag.mockResolvedValue({});
});

it('responds 200 and does nothing when the payload is not a quick_reply', async () => {
  const req = { body: { type: 'message', payload: { type: 'text' } } };
  const res = mockRes();

  await handleWebhook(req, res);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ success: true });
  expect(doctorApprovalFlow.resolve).not.toHaveBeenCalled();
});

it('responds 200 and does nothing when the button text is not approve/reject', async () => {
  const req = { body: buildQuickReply('maybe', 'gs-1') };
  const res = mockRes();

  await handleWebhook(req, res);

  expect(doctorApprovalFlow.resolve).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
});

describe('a reply that resolves the request', () => {
  const request = {
    id: 1,
    customer_phone: '+919999999999',
    customer_name: 'Jane Doe',
    products: [{ title: 'Amoxicillin', quantity: 2 }],
    status: 'approved',
  };

  beforeEach(() => {
    doctorApprovalFlow.resolve.mockResolvedValue({ outcome: 'resolved', request, slot: 'primary' });
  });

  it('calls resolve with the button text mapped to a status, and notifies the customer', async () => {
    const req = { body: buildQuickReply('Approve', 'gs-1') };
    const res = mockRes();

    await handleWebhook(req, res);

    expect(doctorApprovalFlow.resolve).toHaveBeenCalledWith('gs-1', 'approved');
    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenCalledWith({
      to: '+919999999999',
      contentVariables: { 1: 'Jane Doe', 2: 'Amoxicillin (x2)', 3: 'Approved' },
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('maps a Reject tap to the "rejected" status', async () => {
    const req = { body: buildQuickReply('Reject', 'gs-1') };
    await handleWebhook(req, mockRes());

    expect(doctorApprovalFlow.resolve).toHaveBeenCalledWith('gs-1', 'rejected');
  });

  it('button text matching is case-insensitive and trims whitespace', async () => {
    const req = { body: buildQuickReply('  APPROVE  ', 'gs-1') };
    await handleWebhook(req, mockRes());

    expect(doctorApprovalFlow.resolve).toHaveBeenCalledWith('gs-1', 'approved');
  });

  it('continues (still responds 200) when notifying the customer fails', async () => {
    gupshupService.sendStatusTemplateMessage.mockRejectedValueOnce(new Error('gupshup down'));

    const req = { body: buildQuickReply('Approve', 'gs-1') };
    const res = mockRes();
    await handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('a late reply (already resolved by another doctor)', () => {
  it('notifies the late-replying doctor with the actual final status', async () => {
    doctorApprovalFlow.resolve.mockResolvedValue({
      outcome: 'late',
      slot: 'secondary',
      doctorName: 'Dr Secondary',
      doctorMobile: '+912222222222',
      request: {
        id: 1,
        customer_name: 'Jane Doe',
        products: [],
        status: 'approved',
        doctor_name: 'Dr Primary',
        doctor_mobile: '+911111111111',
      },
    });

    const req = { body: buildQuickReply('Approve', 'gs-2') };
    await handleWebhook(req, mockRes());

    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenCalledWith({
      to: '+912222222222',
      templateId: undefined,
      contentVariables: { 1: 'Jane Doe', 2: 'a prescription request', 3: 'Approved' },
    });
  });

  it('uses a real label (not undefined) when the late reply arrives after the whole chain already timed out', async () => {
    doctorApprovalFlow.resolve.mockResolvedValue({
      outcome: 'late',
      slot: 'quaternary',
      doctorName: 'Ashish',
      doctorMobile: '+919540317803',
      request: {
        id: 1,
        customer_name: 'Escalation Test',
        products: [],
        status: 'failed',
        doctor_name: null,
        doctor_mobile: null,
      },
    });

    await handleWebhook({ body: buildQuickReply('Approve', 'gs-quaternary') }, mockRes());

    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenCalledWith({
      to: '+919540317803',
      templateId: undefined,
      contentVariables: { 1: 'Escalation Test', 2: 'a prescription request', 3: 'closed (no doctor responded in time)' },
    });
  });

  it('uses the doctor-status template with the resolving doctor name when configured', async () => {
    config.gupshup.doctorStatusTemplateId = 'doctor-status-template-id';
    doctorApprovalFlow.resolve.mockResolvedValue({
      outcome: 'late',
      slot: 'secondary',
      doctorName: 'Dr Secondary',
      doctorMobile: '+912222222222',
      request: { id: 1, customer_name: 'Jane Doe', products: [], status: 'approved', doctor_name: 'Dr Primary', doctor_mobile: '+911111111111' },
    });

    await handleWebhook({ body: buildQuickReply('Approve', 'gs-2') }, mockRes());

    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenCalledWith({
      to: '+912222222222',
      templateId: 'doctor-status-template-id',
      contentVariables: { 1: 'Jane Doe', 2: 'Dr Primary', 3: 'Approved' },
    });

    config.gupshup.doctorStatusTemplateId = undefined;
  });

  it('sends nothing when the late reply is a double-tap from the doctor who actually resolved it', async () => {
    doctorApprovalFlow.resolve.mockResolvedValue({
      outcome: 'late',
      slot: 'primary',
      doctorName: 'Dr Primary',
      doctorMobile: '+911111111111',
      request: { id: 1, customer_name: 'Jane Doe', products: [], status: 'approved', doctor_name: 'Dr Primary', doctor_mobile: '+911111111111' },
    });

    await handleWebhook({ body: buildQuickReply('Approve', 'gs-1') }, mockRes());

    expect(gupshupService.sendStatusTemplateMessage).not.toHaveBeenCalled();
  });
});

it('logs and sends nothing for a duplicate delivery of an already-superseded reply', async () => {
  doctorApprovalFlow.resolve.mockResolvedValue({ outcome: 'duplicate' });

  await handleWebhook({ body: buildQuickReply('Approve', 'gs-1') }, mockRes());

  expect(gupshupService.sendStatusTemplateMessage).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith(
    'Duplicate webhook delivery for an already-superseded reply, ignoring',
    expect.objectContaining({ gupshupMessageId: 'gs-1' }),
  );
});

it('logs a warning when the message id is not recognized at all', async () => {
  doctorApprovalFlow.resolve.mockResolvedValue({ outcome: 'unknown' });

  await handleWebhook({ body: buildQuickReply('Approve', 'unknown-gs-id') }, mockRes());

  expect(logger.warn).toHaveBeenCalledWith(
    'Button reply received but no matching prescription request found',
    { gupshupMessageId: 'unknown-gs-id' },
  );
});

describe('Shopify order resolution side effects (RX_ORDER_HOLD_ACTIONS_ENABLED)', () => {
  const requestWithOrderGid = {
    id: 1,
    customer_phone: '+919999999999',
    customer_name: 'Jane Doe',
    products: [{ title: 'Amoxicillin', quantity: 2, variant_id: 555 }],
    status: 'approved',
    shopify_order_gid: 'gid://shopify/Order/123',
  };

  afterEach(() => {
    config.shopify.rxOrderHoldActionsEnabled = false;
  });

  it('does nothing when the feature flag is off, even with a shopify_order_gid on the request', async () => {
    doctorApprovalFlow.resolve.mockResolvedValue({ outcome: 'resolved', request: requestWithOrderGid, slot: 'primary' });

    await handleWebhook({ body: buildQuickReply('Approve', 'gs-1') }, mockRes());

    expect(shopifyOrderEditService.clearRxOrderMetafield).not.toHaveBeenCalled();
    expect(shopifyOrderEditService.holdOrderLineItem).not.toHaveBeenCalled();
  });

  it('does nothing when the flag is on but the request has no shopify_order_gid (pre-migration request)', async () => {
    config.shopify.rxOrderHoldActionsEnabled = true;
    doctorApprovalFlow.resolve.mockResolvedValue({
      outcome: 'resolved',
      request: { ...requestWithOrderGid, shopify_order_gid: null },
      slot: 'primary',
    });

    await handleWebhook({ body: buildQuickReply('Approve', 'gs-1') }, mockRes());

    expect(shopifyOrderEditService.clearRxOrderMetafield).not.toHaveBeenCalled();
    expect(shopifyOrderEditService.holdOrderLineItem).not.toHaveBeenCalled();
  });

  it('clears the rx metafield on approve when the flag is on', async () => {
    config.shopify.rxOrderHoldActionsEnabled = true;
    doctorApprovalFlow.resolve.mockResolvedValue({ outcome: 'resolved', request: { ...requestWithOrderGid, status: 'approved' }, slot: 'primary' });

    await handleWebhook({ body: buildQuickReply('Approve', 'gs-1') }, mockRes());

    expect(shopifyOrderEditService.clearRxOrderMetafield).toHaveBeenCalledWith('gid://shopify/Order/123');
    expect(shopifyOrderEditService.removeOrderTag).toHaveBeenCalledWith('gid://shopify/Order/123', 'rx_prescription_order');
    expect(shopifyOrderEditService.holdOrderLineItem).not.toHaveBeenCalled();
  });

  it('holds each Rx line item then clears the metafield on reject when the flag is on', async () => {
    config.shopify.rxOrderHoldActionsEnabled = true;
    doctorApprovalFlow.resolve.mockResolvedValue({ outcome: 'resolved', request: { ...requestWithOrderGid, status: 'rejected' }, slot: 'primary' });

    await handleWebhook({ body: buildQuickReply('Reject', 'gs-1') }, mockRes());

    expect(shopifyOrderEditService.holdOrderLineItem).toHaveBeenCalledWith('gid://shopify/Order/123', 555, undefined);
    expect(shopifyOrderEditService.clearRxOrderMetafield).toHaveBeenCalledWith('gid://shopify/Order/123');
    expect(shopifyOrderEditService.removeOrderTag).toHaveBeenCalledWith('gid://shopify/Order/123', 'rx_prescription_order');
  });

  it('still responds 200 and does not block already-sent notifications when the Shopify call fails', async () => {
    config.shopify.rxOrderHoldActionsEnabled = true;
    doctorApprovalFlow.resolve.mockResolvedValue({ outcome: 'resolved', request: requestWithOrderGid, slot: 'primary' });
    shopifyOrderEditService.clearRxOrderMetafield.mockRejectedValueOnce(new Error('shopify down'));

    const res = mockRes();
    await handleWebhook({ body: buildQuickReply('Approve', 'gs-1') }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to apply Shopify order side effects after doctor decision',
      expect.objectContaining({ error: 'shopify down', shopifyOrderGid: 'gid://shopify/Order/123' }),
    );
  });
});

it('always responds 200 even when an unexpected error is thrown', async () => {
  doctorApprovalFlow.resolve.mockRejectedValue(new Error('db exploded'));

  const res = mockRes();
  await handleWebhook({ body: buildQuickReply('Approve', 'gs-1') }, res);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ success: true });
  expect(logger.error).toHaveBeenCalledWith('Failed to process Gupshup webhook', { error: 'db exploded' });
});
