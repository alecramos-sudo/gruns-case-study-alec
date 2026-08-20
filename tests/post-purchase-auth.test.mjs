import assert from "node:assert/strict";
import test from "node:test";

import { postPurchaseShop } from "../app/domain/post-purchase-auth.mjs";

test("accepts the extension shop when a legacy post-purchase token has no dest", () => {
  assert.equal(
    postPurchaseShop("gruns-case-study.myshopify.com", undefined),
    "gruns-case-study.myshopify.com",
  );
});

test("accepts a matching token destination", () => {
  assert.equal(
    postPurchaseShop(
      "gruns-case-study.myshopify.com",
      "https://gruns-case-study.myshopify.com/admin",
    ),
    "gruns-case-study.myshopify.com",
  );
});

test("rejects a mismatched token destination or invalid shop", () => {
  assert.equal(
    postPurchaseShop(
      "gruns-case-study.myshopify.com",
      "https://another-store.myshopify.com/admin",
    ),
    null,
  );
  assert.equal(postPurchaseShop("not-a-shop.example", undefined), null);
});
