import assert from "node:assert/strict";
import test from "node:test";

import { normalizeShopifyId } from "../app/domain/shopify-id.mjs";

test("Shopify numeric IDs and GIDs normalize to the same value", () => {
  assert.equal(normalizeShopifyId(191167), "191167");
  assert.equal(normalizeShopifyId("191167"), "191167");
  assert.equal(normalizeShopifyId("gid://shopify/Customer/191167"), "191167");
});

test("invalid Shopify IDs are rejected", () => {
  assert.equal(normalizeShopifyId("gid://shopify/Customer/not-a-number"), null);
  assert.equal(normalizeShopifyId(""), null);
});
