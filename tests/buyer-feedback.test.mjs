import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBuyerFeedback } from "../app/domain/buyer-feedback.mjs";

test("fixed feedback never stores stray text", () => {
  assert.deepEqual(normalizeBuyerFeedback("travel", "ignore me"), {
    choice: "travel",
    text: null,
  });
});

test("other feedback is bounded and redacts contact details", () => {
  const result = normalizeBuyerFeedback(
    "other",
    "Email me at buyer@example.com or call +1 (212) 555-0199 about https://example.com",
  );

  assert.equal(result.choice, "other");
  assert.equal(
    result.text,
    "Email me at [removed] or call [removed] about [removed]",
  );
});

test("unknown feedback is rejected", () => {
  assert.throws(
    () => normalizeBuyerFeedback("secret", ""),
    /valid feedback option/,
  );
});
