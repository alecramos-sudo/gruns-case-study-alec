function numericId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function offerVariants(profile) {
  return (profile.variants ?? [])
    .map((variant) => ({
      id: variant.id,
      variantId: numericId(variant.legacyResourceId),
      title:
        variant.selectedOptions
          ?.map(({ name, value }) => `${name}: ${value}`)
          .join(" · ") || variant.title,
      price: variant.price,
      available: variant.available,
    }))
    .filter((variant) => variant.variantId !== null);
}

export function availableOfferVariants(profile) {
  return offerVariants(profile)
    .filter((variant) => variant.available)
    .map(({ available: _available, ...variant }) => variant);
}

export function findOfferVariant(profile, requestedId) {
  const requested = String(requestedId ?? "");
  return offerVariants(profile).find(
    (variant) =>
      variant.id === requested || String(variant.variantId) === requested,
  );
}

export function selectOfferVariant(profile, requestedId) {
  const variants = availableOfferVariants(profile);
  const requested = String(requestedId ?? "");
  const selected = requested
    ? variants.find(
        (variant) =>
          variant.id === requested || String(variant.variantId) === requested,
      )
    : variants[0];
  if (!selected) throw new Error("The selected offer variant is unavailable.");
  return selected;
}
