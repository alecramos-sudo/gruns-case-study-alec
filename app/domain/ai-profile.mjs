import {
  inferMerchandisingRole,
  isMerchandisingRole,
} from "./merchandising-vocabulary.mjs";

export function findUnmappedProduct(catalogProducts, profiles, productId) {
  const product = catalogProducts.find(
    (candidate) => candidate.productId === productId,
  );
  if (!product) throw new Error("Choose an active Shopify product first.");
  if (profiles.some((profile) => profile.productId === productId)) {
    throw new Error("This product already has a merchandising profile.");
  }
  return product;
}

export function buildFallbackProfile(product) {
  const productText = [
    product.title,
    product.productType,
    ...(product.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  const isKids = /kids|child|family|little/.test(productText);
  return {
    productId: product.productId,
    productHandle: product.productHandle,
    title: product.title,
    role: inferMerchandisingRole(product),
    audiences: isKids ? ["kids", "parent"] : ["adult"],
    family: product.productHandle,
    lifecycle: "concept",
    claims: [],
    exclusions: ["same_product"],
    merchantPriority: 5,
    eligible: true,
    rationale: `Drafted from ${product.title}'s Shopify catalog data for merchant review.`,
    generator: "local-fallback",
  };
}

function stringList(value, maximumItems, maximumLength = 80) {
  if (!Array.isArray(value)) return null;
  const normalized = value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim().slice(0, maximumLength))
    .filter(Boolean)
    .slice(0, maximumItems);
  return normalized.length ? normalized : null;
}

export function normalizeProfileDraft(parsed, product, generator) {
  const audiences = stringList(parsed?.audiences, 5);
  const exclusions = stringList(parsed?.exclusions, 5);
  if (
    typeof parsed?.role !== "string" ||
    !isMerchandisingRole(parsed.role.trim()) ||
    !audiences ||
    typeof parsed.family !== "string" ||
    !parsed.family.trim() ||
    typeof parsed.lifecycle !== "string" ||
    !parsed.lifecycle.trim() ||
    !exclusions ||
    !Number.isInteger(parsed.merchantPriority) ||
    typeof parsed.eligible !== "boolean" ||
    typeof parsed.reason !== "string" ||
    !parsed.reason.trim()
  ) {
    return buildFallbackProfile(product);
  }

  const claims = Array.isArray(parsed.claims)
    ? parsed.claims
        .filter((claim) => typeof claim === "string" && claim.trim())
        .map((claim) => claim.trim().slice(0, 120))
        .slice(0, 5)
    : [];
  return {
    productId: product.productId,
    productHandle: product.productHandle,
    title: product.title,
    role: parsed.role.trim(),
    audiences,
    family: parsed.family.trim().slice(0, 80),
    substitutionGroup:
      typeof parsed.substitutionGroup === "string"
        ? parsed.substitutionGroup.trim().slice(0, 80) || undefined
        : undefined,
    lifecycle: parsed.lifecycle.trim().slice(0, 80),
    claims,
    exclusions,
    merchantPriority: Math.min(10, Math.max(1, parsed.merchantPriority)),
    eligible: parsed.eligible,
    rationale: parsed.reason.trim().slice(0, 200),
    generator,
  };
}

export function aiRunAllowed(shopRuns, globalRuns, shopLimit, globalLimit) {
  return shopRuns < shopLimit && globalRuns < globalLimit;
}

export function boundedAiLimit(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(1, parsed));
}
