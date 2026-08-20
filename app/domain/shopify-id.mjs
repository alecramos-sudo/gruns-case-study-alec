/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeShopifyId(value) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/(?:^|\/)(\d+)$/);
  return match?.[1] ?? null;
}
