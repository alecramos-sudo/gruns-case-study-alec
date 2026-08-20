CREATE TABLE "CustomerDataRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "data" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "CustomerDataRequest_shop_requestId_key"
ON "CustomerDataRequest"("shop", "requestId");

CREATE INDEX "CustomerDataRequest_shop_createdAt_idx"
ON "CustomerDataRequest"("shop", "createdAt");

CREATE INDEX "CustomerDataRequest_shop_customerId_idx"
ON "CustomerDataRequest"("shop", "customerId");
