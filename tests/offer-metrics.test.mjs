import test from "node:test";
import assert from "node:assert/strict";

import { offerConversionPercent } from "../app/domain/offer-metrics.mjs";

test("conversion counts every shown offer in the denominator", () => {
  assert.equal(offerConversionPercent(4, 2), 50);
});

test("conversion is zero before an offer is shown", () => {
  assert.equal(offerConversionPercent(0, 0), 0);
});
