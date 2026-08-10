const { config } = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { setRxProductOrderMetafield } = require('./shopify.service');

const FULFILLMENT_ORDERS_QUERY = `
  query GetFulfillmentOrdersForHold($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 10) {
        edges {
          node {
            id
            lineItems(first: 250) {
              edges {
                node {
                  id
                  remainingQuantity
                  sku
                  variant { id }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_ORDER_HOLD_MUTATION = `
  mutation FulfillmentOrderHold($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
      fulfillmentOrder { id status }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

async function callAdminGraphql(query, variables) {
  const response = await fetch(
    `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminApiToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const data = await response.json();
  return { ok: response.ok, data };
}

function assertNoErrors(result, mutationField, message) {
  const userErrors = result.data?.data?.[mutationField]?.userErrors;
  if (!result.ok || result.data.errors || userErrors?.length) {
    throw new ApiError(502, message, { errors: result.data.errors || userErrors });
  }
}

/**
 * Clears (or re-sets) the rx_prescription_order metafield once a doctor has
 * responded — Approved clears it outright; Rejected also clears it after the
 * Rx line item is put on fulfillment hold, so the order-level hold isn't left
 * on for a reason that's now handled at the line-item level instead. Thin
 * wrapper so callers of this file don't need to import shopify.service.js
 * directly for the approve path.
 */
async function clearRxOrderMetafield(orderGid) {
  return setRxProductOrderMetafield(orderGid, false);
}

/**
 * Removes the rx_prescription_order tag once a doctor has responded —
 * this is the actual hold-release signal for the Unicommerce connector
 * (the metafield above is for internal/Admin visibility only). Called
 * alongside clearRxOrderMetafield on both Approve and Reject.
 */
async function removeOrderTag(orderGid, tag) {
  if (!config.shopify.shopDomain || !config.shopify.adminApiToken) {
    logger.warn('Skipping order tag removal: Shopify Admin API not configured');
    return null;
  }

  const result = await callAdminGraphql(TAGS_REMOVE_MUTATION, { id: orderGid, tags: [tag] });
  assertNoErrors(result, 'tagsRemove', 'Failed to remove order tag');

  return result.data.data.tagsRemove.node;
}

/**
 * Places a fulfillment hold on a single Rx line item, leaving every other
 * line item on the order fulfillable — used when a doctor rejects a
 * prescription so the rest of the order can still ship. Holds operate on
 * the fulfillment side, not the order's line items/quantities, so unlike
 * the Order Edit API (orderEditBegin) they aren't blocked by an order
 * having a pending/deferred payment method (e.g. COD) — confirmed against
 * shopify.dev after orderEditBegin returned "The order cannot be edited"
 * for every COD test order on this store.
 *
 * An order can have more than one fulfillment order (e.g. split across
 * locations); this holds the matching line on whichever fulfillment
 * order(s) it appears in. Matches by variant id (+ SKU as a tiebreaker)
 * since that's what's captured on the line item at order-creation time.
 */
async function holdOrderLineItem(orderGid, variantId, sku) {
  if (!config.shopify.shopDomain || !config.shopify.adminApiToken) {
    logger.warn('Skipping order line item hold: Shopify Admin API not configured');
    return null;
  }
  if (!variantId) {
    throw new ApiError(400, 'holdOrderLineItem requires a variantId to match against');
  }

  const variantGid = `gid://shopify/ProductVariant/${variantId}`;

  const query = await callAdminGraphql(FULFILLMENT_ORDERS_QUERY, { id: orderGid });
  if (!query.ok || query.data.errors) {
    throw new ApiError(502, 'Failed to look up fulfillment orders', { errors: query.data.errors });
  }

  const fulfillmentOrders = query.data.data.order?.fulfillmentOrders?.edges || [];
  const results = [];

  for (const { node: fulfillmentOrder } of fulfillmentOrders) {
    const candidates = (fulfillmentOrder.lineItems?.edges || []).map((edge) => edge.node);
    const match =
      candidates.find((node) => node.variant?.id === variantGid && sku && node.sku === sku) ||
      candidates.find((node) => node.variant?.id === variantGid);

    if (!match || match.remainingQuantity <= 0) continue;

    const hold = await callAdminGraphql(FULFILLMENT_ORDER_HOLD_MUTATION, {
      id: fulfillmentOrder.id,
      fulfillmentHold: {
        reason: 'OTHER',
        reasonNotes: 'Rx prescription rejected by doctor',
        lineItems: [{ id: match.id, quantity: match.remainingQuantity }],
      },
    });
    assertNoErrors(hold, 'fulfillmentOrderHold', 'Failed to place fulfillment hold on Rx line item');
    results.push(hold.data.data.fulfillmentOrderHold.fulfillmentOrder);
  }

  if (!results.length) {
    throw new ApiError(404, 'Could not find a matching fulfillable line item to hold on this order', {
      orderGid,
      variantGid,
    });
  }

  return results;
}

module.exports = { clearRxOrderMetafield, holdOrderLineItem, removeOrderTag };
