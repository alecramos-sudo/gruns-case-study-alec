import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { rankOffers } from "../app/domain/offer-engine.mjs";

const fixture = JSON.parse(
  await readFile(
    new URL("../data/merchandising.json", import.meta.url),
    "utf8",
  ),
);

const candidate = (handle, overrides = {}) => ({
  productId: `gid://shopify/Product/${handle}`,
  variantId: `gid://shopify/ProductVariant/${handle}`,
  productHandle: handle,
  available: true,
  ...overrides,
});

const purchase = (handle = "gruns") => ({
  productId: `gid://shopify/Product/${handle}`,
  variantId: `gid://shopify/ProductVariant/${handle}`,
  productHandle: handle,
});

function rank(handles, signals = {}, relations = fixture.relations) {
  return rankOffers({
    purchase: purchase(),
    candidates: handles.map((handle) => candidate(handle)),
    profiles: fixture.profiles,
    relations,
    policy: fixture.policy,
    signals,
  });
}

test("approved merchant weight chooses the default offer", () => {
  const result = rank(["gru-go-travel-tin", "good-greens-club-bottle"]);

  assert.deepEqual(
    result.ranked.map(({ candidate: item }) => item.productHandle),
    ["gru-go-travel-tin", "good-greens-club-bottle"],
  );
  assert.equal(result.ranked[0].breakdown.merchantPairing, 24);
  assert.equal(result.ranked[0].breakdown.recentlyViewed, 0);
});

test("a recent view can outrank the default merchant pairing", () => {
  const result = rank(["gru-go-travel-tin", "good-greens-club-bottle"], {
    recentlyViewed: ["good-greens-club-bottle"],
  });

  assert.equal(
    result.ranked[0].candidate.productHandle,
    "good-greens-club-bottle",
  );
  assert.equal(result.ranked[0].score, 62);
  assert.equal(result.ranked[0].breakdown.recentlyViewed, 40);
  assert.equal(result.ranked[0].breakdown.recentViewMatch, "exact");
});

test("an unapproved viewed product can boost an approved similar product", () => {
  const result = rankOffers({
    purchase: purchase("gruns-kids"),
    candidates: [
      candidate("gruns-retro-washed-fleece-hoodie"),
      candidate("gruns-kids-cozy-fleece-hoodie"),
      candidate("little-gruns-lunchbox"),
    ],
    profiles: fixture.profiles,
    relations: fixture.relations,
    policy: fixture.policy,
    signals: {
      recentlyViewed: ["gruns-retro-washed-fleece-hoodie"],
    },
  });

  assert.equal(
    result.ranked[0].candidate.productHandle,
    "gruns-kids-cozy-fleece-hoodie",
  );
  assert.equal(result.ranked[0].breakdown.recentlyViewed, 30);
  assert.equal(result.ranked[0].breakdown.recentViewMatch, "similar");
  assert.equal(result.excluded[0].reason, "no_approved_relation");
});

test("an exact viewed adult hoodie outranks carry products for Grüns", () => {
  const result = rank(
    [
      "gru-go-travel-tin",
      "gruns-retro-washed-fleece-hoodie",
      "gruns-spacious-canvas-tote-with-color-zipper-pocket",
    ],
    { recentlyViewed: ["gruns-retro-washed-fleece-hoodie"] },
  );

  assert.equal(
    result.ranked[0].candidate.productHandle,
    "gruns-retro-washed-fleece-hoodie",
  );
  assert.equal(result.ranked[0].breakdown.recentViewMatch, "exact");
  assert.equal(result.ranked[0].breakdown.recentlyViewed, 40);
  assert.equal(
    result.ranked.find(
      ({ candidate: item }) =>
        item.productHandle ===
        "gruns-spacious-canvas-tote-with-color-zipper-pocket",
    )?.breakdown.recentlyViewed,
    0,
  );
});

test("stored priorities above the supported range are clamped", () => {
  const relations = fixture.relations.map((relation) =>
    relation.handle === "gruns--gru-go-travel-tin"
      ? { ...relation, baseWeight: 92 }
      : relation,
  );
  const result = rank(["gru-go-travel-tin"], {}, relations);

  assert.equal(result.ranked[0].score, 30);
  assert.equal(result.ranked[0].breakdown.merchantPairing, 30);
});

test("every product already in the checkout is excluded", () => {
  const result = rankOffers({
    purchase: purchase(),
    candidates: [candidate("gru-go-travel-tin")],
    profiles: fixture.profiles,
    relations: fixture.relations,
    policy: fixture.policy,
    signals: {
      purchasedProductIds: [
        "gid://shopify/Product/gruns",
        "gid://shopify/Product/gru-go-travel-tin",
      ],
    },
  });

  assert.equal(result.ranked.length, 0);
  assert.equal(result.excluded[0].reason, "already_purchased");
});

test("the purchased nutrition family is never offered again", () => {
  const result = rank(["gruns-firecracker"]);

  assert.equal(result.ranked.length, 0);
  assert.equal(result.excluded[0].reason, "same_substitution_group");
});

test("inactive and unavailable offers are hard exclusions", () => {
  const relations = fixture.relations.map((relation) =>
    relation.handle === "gruns--gru-go-travel-tin"
      ? { ...relation, active: false }
      : relation,
  );
  const inactive = rank(["gru-go-travel-tin"], {}, relations);
  const unavailable = rankOffers({
    purchase: purchase(),
    candidates: [candidate("good-greens-club-bottle", { available: false })],
    profiles: fixture.profiles,
    relations: fixture.relations,
    policy: fixture.policy,
  });

  assert.equal(inactive.excluded[0].reason, "no_approved_relation");
  assert.equal(unavailable.excluded[0].reason, "unavailable");
});

test("an active substitute relation remains a hard exclusion", () => {
  const relations = fixture.relations.map((relation) =>
    relation.handle === "gruns--gru-go-travel-tin"
      ? { ...relation, relationship: "substitute", active: true }
      : relation,
  );
  const result = rank(["gru-go-travel-tin"], {}, relations);

  assert.equal(result.ranked.length, 0);
  assert.equal(result.excluded[0].reason, "no_approved_relation");
});

test("relations that require unavailable signals stay closed", () => {
  const result = rank(["gruns-good-greens-club-hat"]);

  assert.equal(result.ranked.length, 0);
  assert.equal(result.excluded[0].reason, "missing_required_signal");
});

test("an unmapped catalog product reports its missing profile", () => {
  const result = rankOffers({
    purchase: purchase(),
    candidates: [candidate("unmapped-product")],
    profiles: fixture.profiles,
    relations: fixture.relations,
    policy: fixture.policy,
  });

  assert.equal(result.ranked.length, 0);
  assert.equal(result.excluded[0].reason, "missing_profile");
});
