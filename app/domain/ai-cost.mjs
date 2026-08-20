const LUNA_INPUT_PER_MILLION = 0.2;
const LUNA_CACHED_INPUT_PER_MILLION = 0.02;
const LUNA_OUTPUT_PER_MILLION = 1.2;

export function estimateAiCost({
  model,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  providerCost,
}) {
  if (Number.isFinite(providerCost)) return Math.max(0, providerCost ?? 0);
  if (!String(model).toLowerCase().includes("gpt-5.6-luna")) return 0;
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (uncachedInput * LUNA_INPUT_PER_MILLION +
      cachedInputTokens * LUNA_CACHED_INPUT_PER_MILLION +
      outputTokens * LUNA_OUTPUT_PER_MILLION) /
    1_000_000
  );
}
