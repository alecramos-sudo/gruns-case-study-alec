export function sourceProductWasPurchased(
  profiles,
  sourceHandle,
  purchasedProductIds,
) {
  const source = profiles.find((profile) => profile.handle === sourceHandle);
  return Boolean(source && purchasedProductIds.includes(source.productId));
}
