export function normalizeShopDomain(value) {
  if (typeof value !== "string") return null;
  try {
    const domain = value.includes("://") ? new URL(value).hostname : value;
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain)
      ? domain.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export function postPurchaseShop(requestedShop, tokenDestination) {
  const shop = normalizeShopDomain(requestedShop);
  const tokenShop = normalizeShopDomain(tokenDestination);
  if (!shop || (tokenShop && tokenShop !== shop)) return null;
  return shop;
}
