import assert from "node:assert/strict";
import test from "node:test";

import {
  aiRunAllowed,
  boundedAiLimit,
  buildFallbackProfile,
  findUnmappedProduct,
  normalizeProfileDraft,
} from "../app/domain/ai-profile.mjs";
import { merchandisingRoleLabel } from "../app/domain/merchandising-vocabulary.mjs";

const product = {
  productId: "gid://shopify/Product/1",
  productHandle: "little-gruns-stickers",
  title: "Little Grüns Adventure Stickers",
  description: "A sticker pack.",
  productType: "Accessory",
  tags: ["kids", "family"],
};

test("the local profile fallback is deterministic and audience-aware", () => {
  const first = buildFallbackProfile(product);
  const second = buildFallbackProfile(product);

  assert.deepEqual(first, second);
  assert.deepEqual(first.audiences, ["kids", "parent"]);
  assert.equal(first.generator, "local-fallback");
});

test("invalid model output falls back without publishing", () => {
  const result = normalizeProfileDraft(
    { role: "concept", audiences: [] },
    product,
    "OpenAI · test-model",
  );

  assert.equal(result.generator, "local-fallback");
  assert.equal(result.merchantPriority, 5);
});

test("valid model output is bounded before merchant review", () => {
  const result = normalizeProfileDraft(
    {
      role: " brand_accessory ",
      audiences: [" kids ", "parent"],
      family: "stickers",
      substitutionGroup: null,
      lifecycle: "concept",
      claims: [` ${"x".repeat(140)} `],
      exclusions: ["same_product"],
      merchantPriority: 99,
      eligible: true,
      reason: "A playful add-on for family routines.",
    },
    product,
    "OpenAI · test-model",
  );

  assert.equal(result.generator, "OpenAI · test-model");
  assert.equal(result.role, "brand_accessory");
  assert.deepEqual(result.audiences, ["kids", "parent"]);
  assert.equal(result.claims[0].length, 120);
  assert.equal(result.merchantPriority, 10);
  assert.equal(result.rationale, "A playful add-on for family routines.");
});

test("unknown role values fall back instead of entering Shopify custom data", () => {
  const result = normalizeProfileDraft(
    {
      role: "whatever-the-model-invented",
      audiences: ["adult"],
      family: "stickers",
      substitutionGroup: null,
      lifecycle: "concept",
      claims: [],
      exclusions: ["same_product"],
      merchantPriority: 5,
      eligible: true,
      reason: "A draft.",
    },
    product,
    "OpenAI · test-model",
  );

  assert.equal(result.generator, "local-fallback");
  assert.equal(result.role, "brand_accessory");
});

test("unknown and already-mapped products are rejected before AI runs", () => {
  assert.throws(
    () => findUnmappedProduct([product], [], "missing"),
    /active Shopify product/,
  );
  assert.throws(
    () =>
      findUnmappedProduct(
        [product],
        [{ productId: product.productId }],
        product.productId,
      ),
    /already has a merchandising profile/,
  );
});

test("daily AI limits stop at the configured boundaries", () => {
  assert.equal(aiRunAllowed(4, 24, 5, 25), true);
  assert.equal(aiRunAllowed(5, 24, 5, 25), false);
  assert.equal(aiRunAllowed(4, 25, 5, 25), false);
});

test("AI limit settings stay within safe bounds", () => {
  assert.equal(boundedAiLimit(undefined, 20, 100), 20);
  assert.equal(boundedAiLimit("40", 20, 100), 40);
  assert.equal(boundedAiLimit("0", 20, 100), 1);
  assert.equal(boundedAiLimit("999", 20, 100), 100);
  assert.equal(boundedAiLimit("many", 20, 100), 20);
});

test("internal role values have merchant-facing labels", () => {
  assert.equal(
    merchandisingRoleLabel("routine_accessory"),
    "Routine accessory",
  );
  assert.equal(merchandisingRoleLabel("future_role"), "future role");
});
