ALTER TABLE "OfferDecision" ADD COLUMN "customerId" TEXT;

CREATE INDEX "OfferDecision_shop_customerId_idx"
ON "OfferDecision"("shop", "customerId");
