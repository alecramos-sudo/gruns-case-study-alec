const BLOCKED_RELATIONSHIPS = new Set(["exclude", "substitute"]);
export const PAIRING_PRIORITY_MAX = 30;
export const RECENT_VIEW_BOOST = 40;
export const SIMILAR_RECENT_VIEW_RATIO = 0.75;

function asSet(values = []) {
  return values instanceof Set ? values : new Set(values);
}

function profileForProduct(profiles, product) {
  return profiles.find(
    (profile) =>
      profile.productId === product.productId ||
      profile.productHandle === product.productHandle,
  );
}

function relationFor(relations, source, target) {
  return relations.find(
    (relation) =>
      relation.source === source.handle && relation.target === target.handle,
  );
}

export function relationshipBlocksOffer(relationship) {
  return BLOCKED_RELATIONSHIPS.has(relationship);
}

function exclusionReason({
  purchase,
  purchasedProductIds,
  source,
  candidate,
  target,
  relation,
}) {
  if (!candidate.available) return "unavailable";
  if (target && !target.eligible) return "ineligible";
  if (
    purchasedProductIds.has(candidate.productId) ||
    candidate.productId === purchase.productId ||
    candidate.variantId === purchase.variantId
  ) {
    return "already_purchased";
  }
  if (!target) return "missing_profile";
  if (
    source.substitutionGroup &&
    source.substitutionGroup === target.substitutionGroup
  ) {
    return "same_substitution_group";
  }
  if (!relation?.active || relationshipBlocksOffer(relation.relationship)) {
    return "no_approved_relation";
  }
  if (relation.requiredSignals.length) return "missing_required_signal";
  return null;
}

export function rankOffers({
  purchase,
  candidates,
  profiles,
  relations,
  policy,
  signals = {},
}) {
  const source = profileForProduct(profiles, purchase);
  if (!source) return { ranked: [], excluded: [] };

  const recentlyViewed = asSet(signals.recentlyViewed);
  const recentlyViewedProfiles = profiles.filter(
    (profile) =>
      recentlyViewed.has(profile.productId) ||
      recentlyViewed.has(profile.productHandle),
  );
  const purchasedProductIds = asSet(signals.purchasedProductIds);
  purchasedProductIds.add(purchase.productId);
  const ranked = [];
  const excluded = [];

  for (const candidate of candidates) {
    const target = profileForProduct(profiles, candidate);
    const relation = target
      ? relationFor(relations, source, target)
      : undefined;
    const reason = exclusionReason({
      purchase,
      purchasedProductIds,
      source,
      candidate,
      target,
      relation,
    });

    if (reason || !target || !relation) {
      excluded.push({ candidate, reason: reason ?? "missing_profile" });
      continue;
    }

    const recentViewWeight = Math.min(
      RECENT_VIEW_BOOST,
      Math.max(0, Number(policy.recentlyViewedWeight) || 0),
    );
    const exactRecentView =
      recentlyViewed.has(candidate.productHandle) ||
      recentlyViewed.has(candidate.productId);
    const similarRecentView =
      !exactRecentView &&
      recentlyViewedProfiles.some(
        (viewedProfile) =>
          viewedProfile.role && viewedProfile.role === target.role,
      );
    const recentBoost = exactRecentView
      ? recentViewWeight
      : similarRecentView
        ? Math.round(recentViewWeight * SIMILAR_RECENT_VIEW_RATIO)
        : 0;
    const pairingPriority = Math.min(
      PAIRING_PRIORITY_MAX,
      Math.max(1, Number(relation.baseWeight) || 1),
    );
    ranked.push({
      candidate,
      profile: target,
      relation,
      score: pairingPriority + recentBoost,
      breakdown: {
        merchantPairing: pairingPriority,
        recentlyViewed: recentBoost,
        recentViewMatch: exactRecentView
          ? "exact"
          : similarRecentView
            ? "similar"
            : "none",
      },
    });
  }

  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      left.candidate.productHandle.localeCompare(right.candidate.productHandle),
  );

  return { ranked, excluded };
}
