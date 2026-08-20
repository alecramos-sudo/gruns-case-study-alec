import prisma from "../db.server";

export const CHECKOUT_INTENT_RETENTION_HOURS = 24;
export const RAW_FEEDBACK_RETENTION_DAYS = 30;
export const CUSTOMER_DATA_REQUEST_RETENTION_DAYS = 30;
export const MAX_CHECKOUT_INTENTS_PER_SHOP = 500;

export async function pruneCheckoutIntents(shop: string, now = new Date()) {
  const cutoff = new Date(
    now.getTime() - CHECKOUT_INTENT_RETENTION_HOURS * 60 * 60 * 1000,
  );
  await prisma.checkoutIntent.deleteMany({
    where: { shop, updatedAt: { lt: cutoff } },
  });

  const overflow = await prisma.checkoutIntent.findMany({
    where: { shop },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    skip: MAX_CHECKOUT_INTENTS_PER_SHOP,
    select: { id: true },
  });
  if (!overflow.length) return;
  await prisma.checkoutIntent.deleteMany({
    where: { id: { in: overflow.map(({ id }) => id) } },
  });
}

export async function pruneRawFeedback(shop: string, now = new Date()) {
  const cutoff = new Date(
    now.getTime() - RAW_FEEDBACK_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  return prisma.offerDecision.updateMany({
    where: {
      shop,
      feedbackText: { not: null },
      createdAt: { lt: cutoff },
    },
    data: { feedbackText: null },
  });
}

export async function redactCustomerData(shop: string, customerId: string) {
  return prisma.$transaction([
    prisma.offerDecision.updateMany({
      where: { shop, customerId },
      data: {
        customerId: null,
        feedbackChoice: null,
        feedbackText: null,
      },
    }),
    prisma.customerDataRequest.deleteMany({ where: { shop, customerId } }),
  ]);
}

export async function pruneCustomerDataRequests(
  shop: string,
  now = new Date(),
) {
  const cutoff = new Date(
    now.getTime() - CUSTOMER_DATA_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  return prisma.customerDataRequest.deleteMany({
    where: { shop, createdAt: { lt: cutoff } },
  });
}

export async function deleteShopData(shop: string) {
  return prisma.$transaction([
    prisma.checkoutIntent.deleteMany({ where: { shop } }),
    prisma.offerDecision.deleteMany({ where: { shop } }),
    prisma.aiDailyUsage.deleteMany({ where: { shop } }),
    prisma.customerDataRequest.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);
}
