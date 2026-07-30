# Rx Order Hold: Shopify → Unicommerce

## Problem

Zigly is adding an e-pharmacy category. For orders containing a prescription
(Rx) medicine, the order must not be picked or shipped until a doctor
approves the prescription. That approval already happens over WhatsApp via
our Gupshup integration (see `gupshupWebhook.controller.js` and
`prescription.controller.js`), which records `pending` / `approved` /
`rejected` status per request in the `prescription_requests` table.

The gap: order sync from Shopify into Unicommerce today runs entirely
through the Unicommerce connector. We have no backend in that path, so we
have no way to stop an Rx order from being picked/shipped while approval is
still pending.

## Questions raised with the connector/Unicommerce team

1. Can the connector auto-hold an order at creation based on a tag or SKU?
   (preferred, if possible)
2. If not, is there a webhook/callback on order creation we can use to call
   Hold immediately, instead of polling?
3. What does `verificationRequired` on Create Sale Order actually do?
4. Do we have existing API credentials for Hold / Unhold / Cancel / Search
   Sale Order, or do new ones need to be issued?
5. Whole-order hold or item-level hold — which fits this case?
6. Can Cancel Sale Order cancel a single line item, leaving the rest of the
   order to ship?
7. Is there a sandbox tenant available to test against?

## Answer received

The connector does not support auto-hold by tag/SKU, and there's no
order-creation webhook/callback exposed. Unicommerce's recommended pattern
instead is:

**Hold the order at Shopify, before it ever reaches Unicommerce.**

- Shopify order sync to Unicommerce runs on a delay (configurable hold
  window at the connector level).
- If the prescription is approved within that window, the order (with any
  required updates) syncs to Unicommerce and proceeds through normal
  picking/shipping.
- If rejected, the necessary changes are made directly in Shopify — cancel
  the Rx line item, or the whole order, depending on our business rules —
  **before** the order reaches Unicommerce at all.

In short: the hold/branch point moves from Unicommerce to Shopify. This
sidesteps the whole-order-vs-item-level-hold and Cancel-single-line
questions on the Unicommerce side, since rejection is handled in Shopify
before Unicommerce is ever involved.

## Implications for us

- The doctor-approval loop we've already built (Gupshup template send →
  WhatsApp Approve/Reject button → `gupshupWebhook.controller.js` updates
  `prescription_requests.status`) is the right mechanism to drive this — no
  new approval channel needed.
- What's missing is the Shopify-side action once a status lands:
  - **Approved**: no order change needed (or apply queued updates, if any),
    let the existing connector hold window elapse and sync normally.
  - **Rejected**: call the Shopify Admin API to cancel/remove the Rx line
    item (or cancel the whole order, per business rule) before the hold
    window elapses.
- This requires:
  - Knowing/configuring the connector's hold-window duration for Rx orders
    (tag- or SKU-based order identification on the Shopify side).
  - Linking a `prescription_requests` row back to a specific Shopify order
    and line item — `shopify_order_id` is already captured for the
    auto-consult/auto-upload flows; line-item id is not currently stored and
    would be needed for line-level cancellation.
  - Deciding whole-order vs line-item cancellation on rejection (business
    call, not a technical constraint anymore).
  - Confirming the hold window is long enough to cover realistic doctor
    response times, with a defined fallback if approval doesn't land in
    time (e.g. treat as hold-expired → escalate or default to reject).

## Next step

Loop in the Shopify dev team to scope a pharmacy-specific hold flow:
tag/identify Rx orders at checkout, configure the connector's hold window,
and wire the existing approve/reject webhook to the Shopify Admin API for
line-item or order cancellation on rejection.
