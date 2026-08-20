-- CreateTable
CREATE TABLE "CheckoutIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "checkoutToken" TEXT NOT NULL,
    "recentlyViewed" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OfferDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "sourceHandle" TEXT NOT NULL,
    "offerHandle" TEXT NOT NULL,
    "offerVariantId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "rationale" TEXT NOT NULL,
    "usedRecentView" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "revenue" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shownAt" DATETIME,
    "acceptedAt" DATETIME,
    "declinedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "CheckoutIntent_shop_updatedAt_idx" ON "CheckoutIntent"("shop", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutIntent_shop_checkoutToken_key" ON "CheckoutIntent"("shop", "checkoutToken");

-- CreateIndex
CREATE INDEX "OfferDecision_shop_createdAt_idx" ON "OfferDecision"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "OfferDecision_shop_status_createdAt_idx" ON "OfferDecision"("shop", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OfferDecision_shop_referenceId_key" ON "OfferDecision"("shop", "referenceId");
