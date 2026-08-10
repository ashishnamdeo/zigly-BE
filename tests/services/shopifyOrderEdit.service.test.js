jest.mock('../../src/config/env', () => ({
  config: {
    shopify: {
      shopDomain: 'test-shop.myshopify.com',
      adminApiToken: 'test-admin-token',
      apiVersion: '2026-01',
      rxMetafieldNamespace: 'custom',
      rxMetafieldKey: 'rx_prescription_order',
    },
  },
}));
jest.mock('../../src/utils/logger');
jest.mock('../../src/services/shopify.service', () => ({
  setRxProductOrderMetafield: jest.fn(),
}));

const { setRxProductOrderMetafield } = require('../../src/services/shopify.service');
const shopifyOrderEditService = require('../../src/services/shopifyOrderEdit.service');

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  global.fetch = jest.fn();
});

describe('clearRxOrderMetafield', () => {
  it('delegates to shopify.service.setRxProductOrderMetafield with false', async () => {
    setRxProductOrderMetafield.mockResolvedValue({ id: 'mf-1' });

    const result = await shopifyOrderEditService.clearRxOrderMetafield('gid://shopify/Order/123');

    expect(setRxProductOrderMetafield).toHaveBeenCalledWith('gid://shopify/Order/123', false);
    expect(result).toEqual({ id: 'mf-1' });
  });
});

describe('holdOrderLineItem', () => {
  const orderGid = 'gid://shopify/Order/123';
  const fulfillmentOrderGid = 'gid://shopify/FulfillmentOrder/777';
  const foLineItemGid = 'gid://shopify/FulfillmentOrderLineItem/456';

  function mockFulfillmentOrdersResponse({ variant = 'gid://shopify/ProductVariant/555', sku = 'SKU-1', remainingQuantity = 1 } = {}) {
    return jsonResponse({
      data: {
        order: {
          fulfillmentOrders: {
            edges: [
              {
                node: {
                  id: fulfillmentOrderGid,
                  lineItems: {
                    edges: [
                      { node: { id: foLineItemGid, remainingQuantity, sku, variant: { id: variant } } },
                      { node: { id: 'gid://shopify/FulfillmentOrderLineItem/other', remainingQuantity: 3, sku: 'SKU-OTHER', variant: { id: 'gid://shopify/ProductVariant/999' } } },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    });
  }

  function mockHoldResponse() {
    return jsonResponse({
      data: { fulfillmentOrderHold: { fulfillmentOrder: { id: fulfillmentOrderGid, status: 'ON_HOLD' }, userErrors: [] } },
    });
  }

  it('looks up fulfillment orders then holds only the matching line item by variant id', async () => {
    global.fetch.mockResolvedValueOnce(mockFulfillmentOrdersResponse()).mockResolvedValueOnce(mockHoldResponse());

    const result = await shopifyOrderEditService.holdOrderLineItem(orderGid, 555, 'SKU-1');

    expect(global.fetch).toHaveBeenCalledTimes(2);

    const [, queryOptions] = global.fetch.mock.calls[0];
    expect(JSON.parse(queryOptions.body).variables).toEqual({ id: orderGid });

    const [, holdOptions] = global.fetch.mock.calls[1];
    expect(JSON.parse(holdOptions.body).variables).toEqual({
      id: fulfillmentOrderGid,
      fulfillmentHold: {
        reason: 'OTHER',
        reasonNotes: 'Rx prescription rejected by doctor',
        lineItems: [{ id: foLineItemGid, quantity: 1 }],
      },
    });

    expect(result).toEqual([{ id: fulfillmentOrderGid, status: 'ON_HOLD' }]);
  });

  it('throws when no matching fulfillable line item is found', async () => {
    global.fetch.mockResolvedValueOnce(mockFulfillmentOrdersResponse({ variant: 'gid://shopify/ProductVariant/000' }));

    await expect(shopifyOrderEditService.holdOrderLineItem(orderGid, 555, 'SKU-1')).rejects.toThrow(
      'Could not find a matching fulfillable line item to hold on this order',
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('skips a matched line item with zero remaining quantity (already fulfilled)', async () => {
    global.fetch.mockResolvedValueOnce(mockFulfillmentOrdersResponse({ remainingQuantity: 0 }));

    await expect(shopifyOrderEditService.holdOrderLineItem(orderGid, 555, 'SKU-1')).rejects.toThrow(
      'Could not find a matching fulfillable line item to hold on this order',
    );
  });

  it('throws when the fulfillment order lookup fails', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'boom' }] }, false, 500));

    await expect(shopifyOrderEditService.holdOrderLineItem(orderGid, 555)).rejects.toThrow(
      'Failed to look up fulfillment orders',
    );
  });

  it('throws when fulfillmentOrderHold returns userErrors', async () => {
    global.fetch.mockResolvedValueOnce(mockFulfillmentOrdersResponse()).mockResolvedValueOnce(
      jsonResponse({ data: { fulfillmentOrderHold: { fulfillmentOrder: null, userErrors: [{ field: ['id'], message: 'already on hold' }] } } }),
    );

    await expect(shopifyOrderEditService.holdOrderLineItem(orderGid, 555, 'SKU-1')).rejects.toThrow(
      'Failed to place fulfillment hold on Rx line item',
    );
  });

  it('throws when variantId is missing', async () => {
    await expect(shopifyOrderEditService.holdOrderLineItem(orderGid, undefined)).rejects.toThrow(
      'holdOrderLineItem requires a variantId to match against',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('removeOrderTag', () => {
  it('posts a tagsRemove mutation with the order gid and tag', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ data: { tagsRemove: { node: { id: 'gid://shopify/Order/123' }, userErrors: [] } } }),
    );

    const result = await shopifyOrderEditService.removeOrderTag('gid://shopify/Order/123', 'rx_prescription_order');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body).variables).toEqual({
      id: 'gid://shopify/Order/123',
      tags: ['rx_prescription_order'],
    });
    expect(result).toEqual({ id: 'gid://shopify/Order/123' });
  });

  it('throws an ApiError when Shopify returns userErrors', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ data: { tagsRemove: { node: null, userErrors: [{ field: ['id'], message: 'not found' }] } } }),
    );

    await expect(
      shopifyOrderEditService.removeOrderTag('gid://shopify/Order/123', 'rx_prescription_order'),
    ).rejects.toMatchObject({ statusCode: 502, message: 'Failed to remove order tag' });
  });
});
