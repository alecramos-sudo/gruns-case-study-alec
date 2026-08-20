import test from "node:test";
import assert from "node:assert/strict";

import { sourceProductWasPurchased } from "../app/domain/post-purchase-order.mjs";

const profiles = [
  {
    handle: "gruns",
    productId: "gid://shopify/Product/123",
  },
];

test("accepts a decision whose source product is in Shopify's order", () => {
  assert.equal(
    sourceProductWasPurchased(profiles, "gruns", [
      "gid://shopify/Product/123",
    ]),
    true,
  );
});

test("rejects client product claims that are absent from Shopify's order", () => {
  assert.equal(
    sourceProductWasPurchased(profiles, "gruns", [
      "gid://shopify/Product/999",
    ]),
    false,
  );
});
