import prisma from "../db.server";
import { rankOffers, relationshipBlocksOffer } from "./offer-engine.mjs";
import { sourceProductWasPurchased } from "./post-purchase-order.mjs";
import {
  availableOfferVariants,
  findOfferVariant,
  selectOfferVariant,
} from "./offer-variant.mjs";
import type {
  MerchandisingEngine,
  MerchandisingProfile,
  OfferRelation,
} from "./merchandising.server";
import { signedChangeset } from "./tokens.server";

export type BuyerOffer = {
  id: string;
  productTitle: string;
  productImageURL: string;
  productDescription: string[];
  originalPrice: string;
  rationale: string;
  signalLabel: string;
  variants: Array<{
    variantId: number;
    title: string;
    price: string;
  }>;
  changes: Array<{
    type: "add_variant";
    variantId: number;
    quantity: number;
    discount: {
      value: number;
      valueType: "percentage";
      title: string;
    };
  }>;
};

function discountPercent(relation: OfferRelation) {
  return Math.round(Math.min(0.5, Math.max(0, relation.maxDiscount)) * 100);
}

function offerFrom(
  id: string,
  profile: MerchandisingProfile,
  relation: OfferRelation,
  recentViewMatch: string,
  requestedVariantId?: string | number,
): BuyerOffer {
  const selectedVariant = selectOfferVariant(profile, requestedVariantId);
  const variants = availableOfferVariants(profile);
  const discount = discountPercent(relation);
  return {
    id,
    productTitle: profile.title,
    productImageURL: profile.imageUrl ?? "",
    productDescription: [
      (profile.description || relation.rationale).slice(0, 150),
    ],
    originalPrice: selectedVariant.price,
    rationale: relation.rationale,
    signalLabel:
      recentViewMatch === "exact"
        ? "Because you viewed this"
        : recentViewMatch === "similar"
          ? "Based on a similar product you viewed"
          : "Recommended for your routine",
    variants: variants.map(
      ({ variantId, title, price }: BuyerOffer["variants"][number]) => ({
        variantId,
        title,
        price,
      }),
    ),
    changes: [
      {
        type: "add_variant",
        variantId: selectedVariant.variantId,
        quantity: 1,
        discount: {
          value: discount,
          valueType: "percentage",
          title: `${discount}% off`,
        },
      },
    ],
  };
}

function sourcesFromProductIds(
  engine: MerchandisingEngine,
  productIds: number[],
) {
  return productIds
    .map((id) => `gid://shopify/Product/${String(id)}`)
    .map((productId) =>
      engine.profiles.find((profile) => profile.productId === productId),
    )
    .filter((profile): profile is MerchandisingProfile => Boolean(profile));
}

function activeOfferPath(
  engine: MerchandisingEngine,
  sourceHandle: string,
  offerHandle: string,
) {
  const source = engine.profiles.find(
    (candidate) => candidate.handle === sourceHandle,
  );
  const profile = engine.profiles.find(
    (candidate) => candidate.handle === offerHandle,
  );
  const relation = engine.relations.find(
    (candidate) =>
      candidate.source === sourceHandle && candidate.target === offerHandle,
  );
  if (
    !source ||
    !profile?.available ||
    !profile.eligible ||
    !relation?.active ||
    relationshipBlocksOffer(relation.relationship) ||
    relation.requiredSignals.length > 0 ||
    (source.substitutionGroup &&
      source.substitutionGroup === profile.substitutionGroup)
  ) {
    return null;
  }
  return { profile, relation };
}

export async function prepareOffer({
  shop,
  referenceId,
  customerId,
  productIds,
  engine,
}: {
  shop: string;
  referenceId: string;
  customerId?: string;
  productIds: number[];
  engine: MerchandisingEngine;
}) {
  const existing = await prisma.offerDecision.findUnique({
    where: { shop_referenceId: { shop, referenceId } },
  });
  if (existing) {
    if (existing.status === "accepted" || existing.status === "declined") {
      return null;
    }
    if (customerId && !existing.customerId) {
      await prisma.offerDecision.update({
        where: { id: existing.id },
        data: { customerId },
      });
    }
    const path = activeOfferPath(
      engine,
      existing.sourceHandle,
      existing.offerHandle,
    );
    return path
      ? offerFrom(
          existing.id,
          path.profile,
          path.relation,
          existing.recentViewMatch,
          existing.offerVariantId,
        )
      : null;
  }

  const sources = sourcesFromProductIds(engine, productIds);
  if (!sources.length) return null;
  const intent = await prisma.checkoutIntent.findUnique({
    where: { shop_checkoutToken: { shop, checkoutToken: referenceId } },
  });
  let recentlyViewed: string[] = [];
  try {
    const value = JSON.parse(intent?.recentlyViewed ?? "[]");
    if (Array.isArray(value)) {
      recentlyViewed = value.filter(
        (item): item is string => typeof item === "string",
      );
    }
  } catch {
    recentlyViewed = [];
  }

  const purchasedProductIds = productIds.map(
    (id) => `gid://shopify/Product/${String(id)}`,
  );
  let source: MerchandisingProfile | undefined;
  let decision: ReturnType<typeof rankOffers>["ranked"][number] | undefined;
  for (const candidateSource of sources) {
    const ranked = rankOffers({
      purchase: {
        productId: candidateSource.productId,
        variantId: candidateSource.variantId,
        productHandle: candidateSource.productHandle,
      },
      candidates: engine.profiles.map((profile) => ({
        productId: profile.productId,
        variantId: profile.variantId,
        productHandle: profile.productHandle,
        available: profile.available,
      })),
      profiles: engine.profiles,
      relations: engine.relations,
      policy: engine.policy,
      signals: { recentlyViewed, purchasedProductIds },
    }).ranked[0];
    if (ranked) {
      source = candidateSource;
      decision = ranked;
      break;
    }
  }
  if (!source || !decision?.candidate.variantId) return null;

  const usedRecentView = decision.breakdown.recentlyViewed > 0;
  const recentViewMatch = decision.breakdown.recentViewMatch;
  const saved = await prisma.offerDecision.upsert({
    where: { shop_referenceId: { shop, referenceId } },
    create: {
      shop,
      customerId,
      referenceId,
      sourceHandle: source.handle,
      offerHandle: decision.profile.handle,
      offerVariantId: decision.candidate.variantId,
      score: decision.score,
      rationale: decision.relation.rationale,
      usedRecentView,
      recentViewMatch,
    },
    update: {},
  });
  return offerFrom(
    saved.id,
    decision.profile,
    decision.relation,
    recentViewMatch,
  );
}

export async function signDecision({
  shop,
  referenceId,
  decisionId,
  variantId,
  engine,
  purchasedProductIds,
}: {
  shop: string;
  referenceId: string;
  decisionId: string;
  variantId: number;
  engine: MerchandisingEngine;
  purchasedProductIds: string[];
}) {
  const decision = await prisma.offerDecision.findFirst({
    where: { id: decisionId, shop, referenceId },
  });
  if (
    !decision ||
    decision.status === "accepted" ||
    decision.status === "declined"
  ) {
    throw new Error("The selected offer is no longer available.");
  }
  const path = activeOfferPath(
    engine,
    decision.sourceHandle,
    decision.offerHandle,
  );
  if (!path) throw new Error("The offer is no longer eligible.");
  if (
    !sourceProductWasPurchased(
      engine.profiles,
      decision.sourceHandle,
      purchasedProductIds,
    )
  ) {
    throw new Error("The purchased products could not be verified.");
  }
  const { profile, relation } = path;
  const selectedVariant = selectOfferVariant(profile, variantId);
  await prisma.offerDecision.update({
    where: { id: decision.id },
    data: { offerVariantId: selectedVariant.id },
  });
  return signedChangeset({
    referenceId,
    changes: offerFrom(
      decision.id,
      profile,
      relation,
      decision.recentViewMatch,
      selectedVariant.variantId,
    ).changes,
  });
}

export async function recordOutcome({
  shop,
  referenceId,
  decisionId,
  event,
  engine,
  feedback,
}: {
  shop: string;
  referenceId: string;
  decisionId: string;
  event: "impression" | "accepted" | "declined";
  engine?: MerchandisingEngine;
  feedback?: { choice: string | null; text: string | null };
}) {
  const decision = await prisma.offerDecision.findFirst({
    where: { id: decisionId, shop, referenceId },
  });
  if (!decision) throw new Error("Offer decision not found.");
  if (decision.status === "accepted" || decision.status === "declined") {
    return decision;
  }
  const now = new Date();
  if (event === "impression" && !decision.shownAt) {
    return prisma.offerDecision.update({
      where: { id: decision.id },
      data: { status: "shown", shownAt: now },
    });
  }
  if (event === "accepted") {
    if (!engine)
      throw new Error("The offer engine is required for acceptance.");
    const profile = engine.profiles.find(
      (candidate) => candidate.handle === decision.offerHandle,
    );
    const relation = engine.relations.find(
      (candidate) =>
        candidate.source === decision.sourceHandle &&
        candidate.target === decision.offerHandle,
    );
    const price = Number(
      profile
        ? findOfferVariant(profile, decision.offerVariantId)?.price
        : undefined,
    );
    const revenue =
      relation && Number.isFinite(price)
        ? Math.max(0, price * (1 - discountPercent(relation) / 100))
        : null;
    return prisma.offerDecision.update({
      where: { id: decision.id },
      data: {
        status: "accepted",
        shownAt: decision.shownAt ?? now,
        acceptedAt: now,
        revenue,
        feedbackChoice: feedback?.choice,
        feedbackText: feedback?.text,
      },
    });
  }
  if (event === "declined") {
    return prisma.offerDecision.update({
      where: { id: decision.id },
      data: {
        status: "declined",
        shownAt: decision.shownAt ?? now,
        declinedAt: now,
        feedbackChoice: feedback?.choice,
        feedbackText: feedback?.text,
      },
    });
  }
  return decision;
}
