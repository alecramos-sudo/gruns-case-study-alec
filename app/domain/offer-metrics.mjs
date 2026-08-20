export function offerConversionPercent(shown, accepted) {
  if (!Number.isFinite(shown) || shown <= 0) return 0;
  if (!Number.isFinite(accepted) || accepted <= 0) return 0;
  return Math.round((accepted / shown) * 100);
}
