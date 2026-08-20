import assert from "node:assert/strict";
import test from "node:test";

import { estimateAiCost } from "../app/domain/ai-cost.mjs";

test("GPT-5.6 Luna spend separates cached input", () => {
  const cost = estimateAiCost({
    model: "gpt-5.6-luna",
    inputTokens: 1_000_000,
    cachedInputTokens: 250_000,
    outputTokens: 100_000,
  });

  assert.equal(cost, 0.275);
});

test("provider-reported cost wins for configurable models", () => {
  assert.equal(
    estimateAiCost({
      model: "anthropic/claude-haiku",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      providerCost: 0.003,
    }),
    0.003,
  );
});
