jest.mock('../../src/config/env', () => ({
  config: {
    gupshup: {
      sendTo: '+911111111111',
      sendToSecondary: '+912222222222',
      sendToTertiary: undefined,
      sendToQuaternary: undefined,
      primaryDoctorName: 'Dr Primary',
      secondaryDoctorName: 'Dr Secondary',
      tertiaryDoctorName: undefined,
      quaternaryDoctorName: undefined,
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
jest.mock('../../src/repositories/prescriptionRequest.repository');
jest.mock('../../src/utils/logger');
jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));

const { config } = require('../../src/config/env');
const gupshupService = require('../../src/services/gupshup.service');
const shopifyOrderEditService = require('../../src/services/shopifyOrderEdit.service');
const { updateStatusByMessageId, findByMessageId } = require('../../src/repositories/prescriptionRequest.repository');
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
  expect(updateStatusByMessageId).not.toHaveBeenCalled();
});

it('responds 200 and does nothing when the button text is not approve/reject', async () => {
  const req = { body: buildQuickReply('maybe', 'gs-1') };
  const res = mockRes();

  await handleWebhook(req, res);

  expect(updateStatusByMessageId).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
});

describe('approve reply matching a pending request', () => {
  const updatedRow = {
    id: 1,
    customer_phone: '+919999999999',
    customer_name: 'Jane Doe',
    products: [{ title: 'Amoxicillin', quantity: 2 }],
    gupshup_message_id: 'gs-1',
    secondary_gupshup_message_id: null,
    tertiary_gupshup_message_id: null,
  };

  beforeEach(() => {
    updateStatusByMessageId.mockResolvedValue(updatedRow);
  });

  it('updates status, notifies the customer, and notifies the other configured doctor', async () => {
    const req = { body: buildQuickReply('Approve', 'gs-1') };
    const res = mockRes();

    await handleWebhook(req, res);

    expect(updateStatusByMessageId).toHaveBeenCalledWith('gs-1', 'approved');
    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenCalledTimes(2);

    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenNthCalledWith(1, {
      to: '+919999999999',
      contentVariables: { 1: 'Jane Doe', 2: 'Amoxicillin (x2)', 3: 'Approved' },
    });

    // Primary doctor (gs-1) responded, so only the secondary doctor is "other".
    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenNthCalledWith(2, {
      to: '+912222222222',
      templateId: undefined,
      contentVariables: { 1: 'Jane Doe', 2: 'Amoxicillin (x2)', 3: 'Approved' },
    });

    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('uses the doctor-status template with the responding doctor name when configured', async () => {
    config.gupshup.doctorStatusTemplateId = 'doctor-status-template-id';

    const req = { body: buildQuickReply('Approve', 'gs-1') };
    await handleWebhook(req, mockRes());

    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenNthCalledWith(2, {
      to: '+912222222222',
      templateId: 'doctor-status-template-id',
      contentVariables: { 1: 'Jane Doe', 2: 'Dr Primary', 3: 'Approved' },
    });

    config.gupshup.doctorStatusTemplateId = undefined;
  });

  it('treats a reject button the same way, with "Rejected" status', async () => {
    const req = { body: buildQuickReply('Reject', 'gs-1') };
    await handleWebhook(req, mockRes());

    expect(updateStatusByMessageId).toHaveBeenCalledWith('gs-1', 'rejected');
    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenNthCalledWith(1, {
      to: '+919999999999',
      contentVariables: { 1: 'Jane Doe', 2: 'Amoxicillin (x2)', 3: 'Rejected' },
    });
  });

  it('button text matching is case-insensitive and trims whitespace', async () => {
    const req = { body: buildQuickReply('  APPROVE  ', 'gs-1') };
    await handleWebhook(req, mockRes());

    expect(updateStatusByMessageId).toHaveBeenCalledWith('gs-1', 'approved');
  });

  it('continues (still responds 200) when notifying the customer fails', async () => {
    gupshupService.sendStatusTemplateMessage.mockRejectedValueOnce(new Error('gupshup down'));

    const req = { body: buildQuickReply('Approve', 'gs-1') };
    const res = mockRes();
    await handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

it('replies to the secondary doctor number the same way, resolving "other doctors" relative to it', async () => {
  updateStatusByMessageId.mockResolvedValue({
    id: 1,
    customer_phone: '+919999999999',
    customer_name: 'Jane Doe',
    products: [],
    gupshup_message_id: 'gs-primary',
    secondary_gupshup_message_id: 'gs-2',
    tertiary_gupshup_message_id: null,
  });

  const req = { body: buildQuickReply('Approve', 'gs-2') };
  await handleWebhook(req, mockRes());

  expect(gupshupService.sendStatusTemplateMessage).toHaveBeenNthCalledWith(2, {
    to: '+911111111111',
    templateId: undefined,
    contentVariables: { 1: 'Jane Doe', 2: 'a prescription request', 3: 'Approved' },
  });
});

describe('no pending request matches the reply', () => {
  beforeEach(() => {
    updateStatusByMessageId.mockResolvedValue(null);
  });

  it('logs that it was already resolved when a matching (non-pending) row exists', async () => {
    findByMessageId.mockResolvedValue({ id: 1, status: 'approved' });

    const req = { body: buildQuickReply('Approve', 'gs-1') };
    await handleWebhook(req, mockRes());

    expect(findByMessageId).toHaveBeenCalledWith('gs-1');
    expect(gupshupService.sendStatusTemplateMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Button reply received for a request already resolved by another doctor, ignoring',
      expect.objectContaining({ id: 1, status: 'approved' }),
    );
  });

  it('logs a warning when no matching row exists at all', async () => {
    findByMessageId.mockResolvedValue(null);

    const req = { body: buildQuickReply('Approve', 'unknown-gs-id') };
    await handleWebhook(req, mockRes());

    expect(logger.warn).toHaveBeenCalledWith(
      'Button reply received but no matching prescription request found',
      { gupshupMessageId: 'unknown-gs-id' },
    );
  });
});

describe('Shopify order resolution side effects (RX_ORDER_HOLD_ACTIONS_ENABLED)', () => {
  const rowWithOrderGid = {
    id: 1,
    customer_phone: '+919999999999',
    customer_name: 'Jane Doe',
    products: [{ title: 'Amoxicillin', quantity: 2, variant_id: 555 }],
    gupshup_message_id: 'gs-1',
    secondary_gupshup_message_id: null,
    tertiary_gupshup_message_id: null,
    shopify_order_gid: 'gid://shopify/Order/123',
  };

  afterEach(() => {
    config.shopify.rxOrderHoldActionsEnabled = false;
  });

  it('does nothing when the feature flag is off, even with a shopify_order_gid on the row', async () => {
    updateStatusByMessageId.mockResolvedValue(rowWithOrderGid);

    const req = { body: buildQuickReply('Approve', 'gs-1') };
    await handleWebhook(req, mockRes());

    expect(shopifyOrderEditService.clearRxOrderMetafield).not.toHaveBeenCalled();
    expect(shopifyOrderEditService.holdOrderLineItem).not.toHaveBeenCalled();
  });

  it('does nothing when the flag is on but the row has no shopify_order_gid (pre-migration request)', async () => {
    config.shopify.rxOrderHoldActionsEnabled = true;
    updateStatusByMessageId.mockResolvedValue({ ...rowWithOrderGid, shopify_order_gid: null });

    const req = { body: buildQuickReply('Approve', 'gs-1') };
    await handleWebhook(req, mockRes());

    expect(shopifyOrderEditService.clearRxOrderMetafield).not.toHaveBeenCalled();
    expect(shopifyOrderEditService.holdOrderLineItem).not.toHaveBeenCalled();
  });

  it('clears the rx metafield on approve when the flag is on', async () => {
    config.shopify.rxOrderHoldActionsEnabled = true;
    updateStatusByMessageId.mockResolvedValue(rowWithOrderGid);

    const req = { body: buildQuickReply('Approve', 'gs-1') };
    await handleWebhook(req, mockRes());

    expect(shopifyOrderEditService.clearRxOrderMetafield).toHaveBeenCalledWith('gid://shopify/Order/123');
    expect(shopifyOrderEditService.removeOrderTag).toHaveBeenCalledWith('gid://shopify/Order/123', 'rx_prescription_order');
    expect(shopifyOrderEditService.holdOrderLineItem).not.toHaveBeenCalled();
  });

  it('holds each Rx line item then clears the metafield on reject when the flag is on', async () => {
    config.shopify.rxOrderHoldActionsEnabled = true;
    updateStatusByMessageId.mockResolvedValue(rowWithOrderGid);

    const req = { body: buildQuickReply('Reject', 'gs-1') };
    await handleWebhook(req, mockRes());

    expect(shopifyOrderEditService.holdOrderLineItem).toHaveBeenCalledWith(
      'gid://shopify/Order/123',
      555,
      undefined,
    );
    expect(shopifyOrderEditService.clearRxOrderMetafield).toHaveBeenCalledWith('gid://shopify/Order/123');
    expect(shopifyOrderEditService.removeOrderTag).toHaveBeenCalledWith('gid://shopify/Order/123', 'rx_prescription_order');
  });

  it('still responds 200 and does not block already-sent notifications when the Shopify call fails', async () => {
    config.shopify.rxOrderHoldActionsEnabled = true;
    updateStatusByMessageId.mockResolvedValue(rowWithOrderGid);
    shopifyOrderEditService.clearRxOrderMetafield.mockRejectedValueOnce(new Error('shopify down'));

    const req = { body: buildQuickReply('Approve', 'gs-1') };
    const res = mockRes();
    await handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(gupshupService.sendStatusTemplateMessage).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to apply Shopify order side effects after doctor decision',
      expect.objectContaining({ error: 'shopify down', shopifyOrderGid: 'gid://shopify/Order/123' }),
    );
  });
});

it('always responds 200 even when an unexpected error is thrown', async () => {
  updateStatusByMessageId.mockRejectedValue(new Error('db exploded'));

  const req = { body: buildQuickReply('Approve', 'gs-1') };
  const res = mockRes();
  await handleWebhook(req, res);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ success: true });
  expect(logger.error).toHaveBeenCalledWith('Failed to process Gupshup webhook', { error: 'db exploded' });
});
