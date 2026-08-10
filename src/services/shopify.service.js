const { config } = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const METAFIELDS_SET_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace value }
      userErrors { field message code }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

/**
 * Flags whether an order contains an Rx product, so Admin/Flow can see it on
 * the order without opening line items. Best-effort: silently skipped if the
 * Admin API isn't configured, and errors are the caller's to log — this is a
 * supplementary annotation, not something that should block webhook processing.
 */
async function setRxProductOrderMetafield(orderGid, isRxOrder) {
  if (!config.shopify.shopDomain || !config.shopify.adminApiToken) {
    logger.warn('Skipping rx_prescription_order metafield: Shopify Admin API not configured');
    return null;
  }

  const variables = {
    metafields: [
      {
        ownerId: orderGid,
        namespace: config.shopify.rxMetafieldNamespace,
        key: config.shopify.rxMetafieldKey,
        type: 'boolean',
        value: String(isRxOrder),
      },
    ],
  };

  const response = await fetch(
    `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminApiToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: METAFIELDS_SET_MUTATION, variables }),
    },
  );

  const data = await response.json();
  const userErrors = data?.data?.metafieldsSet?.userErrors;
  if (!response.ok || data.errors || userErrors?.length) {
    throw new ApiError(502, 'Failed to set rx_prescription_order metafield', {
      errors: data.errors || userErrors,
    });
  }

  return data.data.metafieldsSet.metafields[0];
}

/**
 * Adds the rx_prescription_order tag to an order — this is what the
 * Unicommerce connector actually watches to hold the order's sync (the
 * metafield above is for internal/Admin visibility only). Only called when
 * an order has an Rx line item; there's no "remove on false" case here since
 * tags are naturally absent otherwise. Same best-effort contract as
 * setRxProductOrderMetafield: skipped if the Admin API isn't configured, and
 * errors are the caller's to log.
 */
async function addOrderTag(orderGid, tag) {
  if (!config.shopify.shopDomain || !config.shopify.adminApiToken) {
    logger.warn('Skipping order tag add: Shopify Admin API not configured');
    return null;
  }

  const response = await fetch(
    `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminApiToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: TAGS_ADD_MUTATION, variables: { id: orderGid, tags: [tag] } }),
    },
  );

  const data = await response.json();
  const userErrors = data?.data?.tagsAdd?.userErrors;
  if (!response.ok || data.errors || userErrors?.length) {
    throw new ApiError(502, 'Failed to add order tag', { errors: data.errors || userErrors });
  }

  return data.data.tagsAdd.node;
}

module.exports = { setRxProductOrderMetafield, addOrderTag };
