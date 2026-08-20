import assert from "node:assert/strict";
import test from "node:test";

import {
  availableOfferVariants,
  findOfferVariant,
  selectOfferVariant,
} from "../app/domain/offer-variant.mjs";

const profile = {
  variants: [
    {
      id: "gid://shopify/ProductVariant/101",
      legacyResourceId: "101",
      title: "Small",
      available: true,
      price: "40.00",
      selectedOptions: [
        { name: "Color", value: "Green" },
        { name: "Size", value: "S" },
      ],
    },
    {
      id: "gid://shopify/ProductVariant/102",
      legacyResourceId: "102",
      title: "Medium",
      available: false,
      price: "42.00",
      selectedOptions: [
        { name: "Color", value: "Green" },
        { name: "Size", value: "M" },
      ],
    },
  ],
};

test("only available variants are exposed with readable option labels", () => {
  assert.deepEqual(availableOfferVariants(profile), [
    {
      id: "gid://shopify/ProductVariant/101",
      variantId: 101,
      title: "Color: Green · Size: S",
      price: "40.00",
    },
  ]);
});

test("a requested variant must belong to the offered product", () => {
  assert.equal(selectOfferVariant(profile, 101).variantId, 101);
  assert.throws(() => selectOfferVariant(profile, 102), /unavailable/);
  assert.throws(() => selectOfferVariant(profile, 999), /unavailable/);
});

test("an unavailable selected variant remains available for outcome attribution", () => {
  assert.equal(findOfferVariant(profile, 102)?.price, "42.00");
  assert.equal(findOfferVariant(profile, 999), undefined);
});
