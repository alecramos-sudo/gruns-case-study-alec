import prisma from "../db.server";
import { normalizeShopifyId } from "./shopify-id.mjs";

export async function captureCustomerDataRequest({
  shop,
  customerId,
  requestId,
}: {
  shop: string;
  customerId: string;
  requestId: string;
}) {
  const normalizedCustomerId = normalizeShopifyId(customerId);
  if (!normalizedCustomerId) throw new Error("Invalid Shopify customer ID.");
  const decisions = await prisma.offerDecision.findMany({
    where: { shop, customerId: normalizedCustomerId },
    orderBy: { createdAt: "asc" },
    select: {
      sourceHandle: true,
      offerHandle: true,
      score: true,
      status: true,
      usedRecentView: true,
      feedbackChoice: true,
      feedbackText: true,
      createdAt: true,
      shownAt: true,
      acceptedAt: true,
      declinedAt: true,
    },
  });
  const data = JSON.stringify({
    customerId: normalizedCustomerId,
    postPurchaseDecisions: decisions.map((decision) => ({
      ...decision,
      createdAt: decision.createdAt.toISOString(),
      shownAt: decision.shownAt?.toISOString() ?? null,
      acceptedAt: decision.acceptedAt?.toISOString() ?? null,
      declinedAt: decision.declinedAt?.toISOString() ?? null,
    })),
  });
  return prisma.customerDataRequest.upsert({
    where: { shop_requestId: { shop, requestId } },
    create: { shop, requestId, customerId: normalizedCustomerId, data },
    update: { customerId: normalizedCustomerId, data },
  });
}
