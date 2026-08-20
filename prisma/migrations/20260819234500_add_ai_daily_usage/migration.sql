-- CreateTable
CREATE TABLE "AiDailyUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AiDailyUsage_shop_date_key" ON "AiDailyUsage"("shop", "date");
