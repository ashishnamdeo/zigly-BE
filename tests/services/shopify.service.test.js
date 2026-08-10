jest.mock('../../src/config/env', () => ({
  config: {
    shopify: {
      shopDomain: 'test-shop.myshopify.com',
      adminApiToken: 'test-admin-token',
      apiVersion: '2026-01',
      rxMetafieldNamespace: 'custom',
      rxMetafieldKey: 'rx_prescription_order',
      rxTagName: 'rx_prescription_order',
    },
  },
}));
jest.mock('../../src/utils/logger');

const logger = require('../../src/utils/logger');
const shopifyService = require('../../src/services/shopify.service');

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  global.fetch = jest.fn();
});

describe('addOrderTag', () => {
  it('posts a tagsAdd mutation with the order gid and tag', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ data: { tagsAdd: { node: { id: 'gid://shopify/Order/1' }, userErrors: [] } } }),
    );

    const result = await shopifyService.addOrderTag('gid://shopify/Order/1', 'rx_prescription_order');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://test-shop.myshopify.com/admin/api/2026-01/graphql.json');
    expect(options.headers['X-Shopify-Access-Token']).toBe('test-admin-token');
    const body = JSON.parse(options.body);
    expect(body.variables).toEqual({ id: 'gid://shopify/Order/1', tags: ['rx_prescription_order'] });
    expect(result).toEqual({ id: 'gid://shopify/Order/1' });
  });

  it('throws an ApiError when Shopify returns userErrors', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ data: { tagsAdd: { node: null, userErrors: [{ field: ['id'], message: 'not found' }] } } }),
    );

    await expect(shopifyService.addOrderTag('gid://shopify/Order/1', 'rx_prescription_order')).rejects.toMatchObject({
      statusCode: 502,
      message: 'Failed to add order tag',
    });
  });

  it('skips the call and logs a warning when the Admin API is not configured', async () => {
    const { config } = require('../../src/config/env');
    config.shopify.shopDomain = undefined;

    const result = await shopifyService.addOrderTag('gid://shopify/Order/1', 'rx_prescription_order');

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Skipping order tag add: Shopify Admin API not configured');

    config.shopify.shopDomain = 'test-shop.myshopify.com';
  });
});
