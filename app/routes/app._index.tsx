import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import {
  aiProviderStatus,
  generatePairingDrafts,
  generateProfileDraft,
  RELATIONSHIPS,
  type PairingDraft,
  type PairingDraftBatch,
  type ProfileDraft,
} from "../domain/ai-pairing.server";
import { emitAppEvent } from "../domain/app-events.server";
import {
  PAIRING_PRIORITY_MAX,
  rankOffers,
  RECENT_VIEW_BOOST,
  relationshipBlocksOffer,
} from "../domain/offer-engine.mjs";
import { offerConversionPercent } from "../domain/offer-metrics.mjs";
import {
  loadMerchandisingEngine,
  upsertMerchandisingProfile,
  upsertOfferRelation,
  upsertRankingPolicy,
} from "../domain/merchandising.server";
import {
  isMerchandisingRole,
  MERCHANDISING_ROLE_OPTIONS,
  merchandisingRoleLabel,
} from "../domain/merchandising-vocabulary.mjs";
import { loadOrderLinks } from "../domain/order-links.server";
import {
  createPairingAnnotation,
  loadShopifySalesSummary,
  shopifyAnalyticsErrorMessage,
} from "../domain/shopify-analytics.server";
import { enableWebPixel, webPixelStatus } from "../domain/web-pixel.server";
import {
  pruneCustomerDataRequests,
  pruneRawFeedback,
} from "../domain/retention.server";
import { authenticate } from "../shopify.server";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function clamp(value: FormDataEntryValue | null, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Enter a valid number.");
  return Math.min(max, Math.max(min, parsed));
}

function relationType(value: FormDataEntryValue | null) {
  const relationship = String(value ?? "");
  if (!RELATIONSHIPS.includes(relationship as (typeof RELATIONSHIPS)[number])) {
    throw new Error("Choose a valid relationship.");
  }
  return relationship as (typeof RELATIONSHIPS)[number];
}

function parseRecentlyViewed(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string")
          .slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

function maskedToken(value: string) {
  return value.length > 8 ? `…${value.slice(-8)}` : value;
}

function stringList(value: FormDataEntryValue | null, maximumLength = 80) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim().slice(0, maximumLength))
    .filter(Boolean)
    .slice(0, 5);
}

function aggregateOffers(
  decisions: Array<{
    offerHandle: string;
    shownAt: Date | null;
    status: string;
    revenue: number | null;
  }>,
) {
  const byOffer = new Map<
    string,
    {
      offerHandle: string;
      shown: number;
      accepted: number;
      declined: number;
      revenue: number;
    }
  >();
  for (const decision of decisions) {
    const row = byOffer.get(decision.offerHandle) ?? {
      offerHandle: decision.offerHandle,
      shown: 0,
      accepted: 0,
      declined: 0,
      revenue: 0,
    };
    if (decision.shownAt) row.shown += 1;
    if (decision.status === "accepted") row.accepted += 1;
    if (decision.status === "declined") row.declined += 1;
    row.revenue += decision.revenue ?? 0;
    byOffer.set(decision.offerHandle, row);
  }
  return [...byOffer.values()].sort(
    (left, right) =>
      right.revenue - left.revenue || right.accepted - left.accepted,
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  try {
    await Promise.all([
      pruneRawFeedback(session.shop),
      pruneCustomerDataRequests(session.shop),
    ]);
    const [
      engine,
      decisions,
      allDecisions,
      pixelEnabled,
      latestIntent,
      aiUsage,
      shopifyAnalytics,
      privacyRequests,
    ] = await Promise.all([
      loadMerchandisingEngine(admin),
      prisma.offerDecision.findMany({
        where: { shop: session.shop },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
      prisma.offerDecision.findMany({
        where: { shop: session.shop },
        orderBy: { createdAt: "desc" },
        select: {
          offerHandle: true,
          shownAt: true,
          status: true,
          revenue: true,
        },
        take: 500,
      }),
      webPixelStatus(admin).catch(() => false),
      prisma.checkoutIntent.findFirst({
        where: { shop: session.shop },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.aiDailyUsage.findMany({
        where: { shop: session.shop },
        orderBy: { updatedAt: "desc" },
      }),
      loadShopifySalesSummary(admin),
      prisma.customerDataRequest.findMany({
        where: { shop: session.shop },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: { id: true, customerId: true, createdAt: true },
      }),
    ]);
    const perOffer = aggregateOffers(allDecisions);
    const shown = perOffer.reduce((sum, row) => sum + row.shown, 0);
    const accepted = perOffer.reduce((sum, row) => sum + row.accepted, 0);
    const latestDecision = decisions[0];
    const exactIntent = latestDecision
      ? await prisma.checkoutIntent.findUnique({
          where: {
            shop_checkoutToken: {
              shop: session.shop,
              checkoutToken: latestDecision.referenceId,
            },
          },
        })
      : null;
    const provider = aiProviderStatus();
    const orderLinks = await loadOrderLinks(
      admin,
      decisions.map((decision) => decision.referenceId),
    ).catch(() => ({}));
    return {
      engine,
      pixelEnabled,
      shopifyAnalytics,
      ai: {
        ...provider,
        runs: aiUsage.reduce((sum, usage) => sum + usage.runs, 0),
        inputTokens: aiUsage.reduce((sum, usage) => sum + usage.inputTokens, 0),
        cachedInputTokens: aiUsage.reduce(
          (sum, usage) => sum + usage.cachedInputTokens,
          0,
        ),
        outputTokens: aiUsage.reduce(
          (sum, usage) => sum + usage.outputTokens,
          0,
        ),
        estimatedCostUsd: aiUsage.reduce(
          (sum, usage) => sum + usage.estimatedCostUsd,
          0,
        ),
      },
      decisions: decisions.map((decision) => ({
        id: decision.id,
        sourceHandle: decision.sourceHandle,
        offerHandle: decision.offerHandle,
        score: decision.score,
        usedRecentView: decision.usedRecentView,
        recentViewMatch: decision.recentViewMatch,
        status: decision.status,
        feedbackChoice: decision.feedbackChoice,
        feedbackText: decision.feedbackText,
        createdAt: decision.createdAt.toISOString(),
        order: orderLinks[decision.referenceId] ?? null,
      })),
      latestIntent: latestIntent
        ? {
            checkoutToken: maskedToken(latestIntent.checkoutToken),
            recentlyViewed: parseRecentlyViewed(latestIntent.recentlyViewed),
            updatedAt: latestIntent.updatedAt.toISOString(),
          }
        : null,
      signalJoin: latestDecision?.usedRecentView
        ? exactIntent
          ? "exact"
          : "unmatched"
        : "not-used",
      stats: {
        shown,
        accepted,
        conversion: offerConversionPercent(shown, accepted),
        revenue: perOffer.reduce((sum, row) => sum + row.revenue, 0),
        perOffer,
      },
      privacyRequests: privacyRequests.map((privacyRequest) => ({
        id: privacyRequest.id,
        customerId: maskedToken(privacyRequest.customerId),
        createdAt: privacyRequest.createdAt.toISOString(),
      })),
      loadError: null,
    };
  } catch (error) {
    return {
      engine: null,
      pixelEnabled: false,
      shopifyAnalytics: {
        status: "unavailable" as const,
        error: "The app data could not load.",
        query: "",
      },
      ai: {
        configured: false,
        model: "",
        provider: "",
        shopLimit: 20,
        globalLimit: 100,
        runs: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
      decisions: [],
      latestIntent: null,
      signalJoin: "not-used" as const,
      stats: { shown: 0, accepted: 0, conversion: 0, revenue: 0, perOffer: [] },
      privacyRequests: [],
      loadError: errorMessage(error),
    };
  }
};

async function annotatePairing(
  admin: Parameters<typeof createPairingAnnotation>[0],
  title: string,
  description: string,
) {
  try {
    await createPairingAnnotation(admin, { title, description });
    return " Shopify Analytics annotation created.";
  } catch (error) {
    return ` Shopify Analytics annotation unavailable: ${shopifyAnalyticsErrorMessage(error)}`;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "enableRecentView") {
      const endpoint = new URL(
        "/api/checkout-intent",
        process.env.SHOPIFY_APP_URL ?? request.url,
      ).toString();
      await enableWebPixel({ admin, shop: session.shop, endpoint });
      return {
        ok: true,
        notice: "Recent-view Web Pixel enabled.",
        draftBatch: null,
        profileDraft: null,
      };
    }

    const engine = await loadMerchandisingEngine(admin);
    if (intent === "generatePairing") {
      const draftBatch = await generatePairingDrafts(
        engine,
        String(formData.get("sourceHandle") ?? ""),
        session.shop,
      );
      await emitAppEvent({
        admin,
        eventHandle: "ai_pairing_drafts_generated",
        key: `${session.shop}:${Date.now()}:ai-drafts`,
        attributes: {
          recommendations: draftBatch.drafts.length,
          provider: draftBatch.provider,
          model: draftBatch.model,
        },
      }).catch(() => undefined);
      return {
        ok: true,
        notice:
          draftBatch.provider === "Local fallback"
            ? "Local fallback created reviewable recommendations."
            : `${draftBatch.provider} created ${draftBatch.drafts.length} recommendations.`,
        draftBatch,
        profileDraft: null,
      };
    }

    if (intent === "generateProfile") {
      const profileDraft = await generateProfileDraft(
        engine,
        String(formData.get("productId") ?? ""),
        session.shop,
      );
      return {
        ok: true,
        notice: "AI profile draft ready for review.",
        draftBatch: null,
        profileDraft,
      };
    }

    if (intent === "publishProfile") {
      const productId = String(formData.get("productId") ?? "");
      const product = engine.catalogProducts.find(
        (candidate) => candidate.productId === productId,
      );
      if (!product)
        throw new Error("The selected product is no longer active.");
      const existingProfile = engine.profiles.find(
        (profile) => profile.productId === productId,
      );
      const requestedProfileHandle = String(
        formData.get("profileHandle") ?? "",
      );
      if (
        existingProfile &&
        requestedProfileHandle !== existingProfile.handle
      ) {
        throw new Error("The selected merchandising profile changed.");
      }
      const role = String(formData.get("role") ?? "").trim();
      const family = String(formData.get("family") ?? "")
        .trim()
        .slice(0, 80);
      const lifecycle = String(formData.get("lifecycle") ?? "")
        .trim()
        .slice(0, 80);
      const audiences = stringList(formData.get("audiences"));
      const exclusions = stringList(formData.get("exclusions"));
      if (
        !isMerchandisingRole(role) ||
        !family ||
        !lifecycle ||
        !audiences.length ||
        !exclusions.length
      ) {
        throw new Error(
          "Choose an approved role and provide audience, family, lifecycle, and one exclusion.",
        );
      }
      await upsertMerchandisingProfile(admin, {
        name: product.title,
        handle: existingProfile?.handle ?? product.productHandle,
        productId,
        role,
        audiences,
        family,
        substitutionGroup:
          String(formData.get("substitutionGroup") ?? "")
            .trim()
            .slice(0, 80) || undefined,
        lifecycle,
        claims: stringList(formData.get("claims"), 120),
        exclusions,
        merchantPriority: clamp(formData.get("merchantPriority"), 1, 10),
        eligible: formData.getAll("eligible").includes("true"),
      });
      return {
        ok: true,
        notice: "Merchandising profile approved and saved to Shopify.",
        draftBatch: null,
        profileDraft: null,
      };
    }

    if (intent === "updatePolicy") {
      const recentlyViewedWeight = clamp(
        formData.get("recentlyViewedWeight"),
        0,
        RECENT_VIEW_BOOST,
      );
      await upsertRankingPolicy(admin, {
        ...engine.policy,
        recentlyViewedWeight,
      });
      return {
        ok: true,
        notice: "Ranking policy saved to Shopify custom data.",
        draftBatch: null,
        profileDraft: null,
      };
    }

    if (intent === "publishPairing") {
      const sourceHandle = String(formData.get("sourceHandle") ?? "");
      const targetHandle = String(formData.get("targetHandle") ?? "");
      const source = engine.profiles.find(
        (profile) => profile.handle === sourceHandle,
      );
      const target = engine.profiles.find(
        (profile) => profile.handle === targetHandle,
      );
      if (!source || !target || source.handle === target.handle) {
        throw new Error("The draft references an invalid product pairing.");
      }
      const existing = engine.relations.find(
        (relation) =>
          relation.source === sourceHandle && relation.target === targetHandle,
      );
      const rationale = String(formData.get("rationale") ?? "")
        .trim()
        .slice(0, 200);
      if (!rationale) throw new Error("The pairing needs a reason.");
      const priority = clamp(
        formData.get("baseWeight"),
        1,
        PAIRING_PRIORITY_MAX,
      );
      await upsertOfferRelation(admin, engine, {
        handle: existing?.handle ?? `${sourceHandle}--${targetHandle}`,
        name: existing?.name ?? `${source.title} → ${target.title}`,
        source: sourceHandle,
        target: targetHandle,
        relationship: relationType(formData.get("relationship")),
        baseWeight: priority,
        rationale,
        active: true,
        maxDiscount: existing?.maxDiscount ?? 0.15,
        requiredSignals: existing?.requiredSignals ?? [],
      });
      const annotation = await annotatePairing(
        admin,
        `Post-purchase pairing: ${source.title} → ${target.title}`,
        `Published at priority ${priority}. ${rationale}`,
      );
      return {
        ok: true,
        notice: `Approved pairing published to Shopify custom data.${annotation}`,
        draftBatch: null,
        profileDraft: null,
      };
    }

    if (intent === "updateRelation") {
      const relation = engine.relations.find(
        (candidate) =>
          candidate.handle === String(formData.get("relationHandle") ?? ""),
      );
      if (!relation) throw new Error("The selected pairing no longer exists.");
      const priority = clamp(
        formData.get("baseWeight"),
        1,
        PAIRING_PRIORITY_MAX,
      );
      const discountPercent = clamp(formData.get("maxDiscount"), 0, 50);
      const discount = discountPercent / 100;
      const active =
        formData.getAll("active").includes("true") &&
        !relationshipBlocksOffer(relation.relationship);
      await upsertOfferRelation(admin, engine, {
        ...relation,
        baseWeight: priority,
        maxDiscount: discount,
        active,
      });
      const annotation = await annotatePairing(
        admin,
        `Post-purchase pairing updated: ${relation.name}`,
        `Priority ${priority}; offer discount ${Math.round(discount * 100)}%.`,
      );
      return {
        ok: true,
        notice: `Pairing settings saved to Shopify custom data.${annotation}`,
        draftBatch: null,
        profileDraft: null,
      };
    }

    throw new Error("Unknown action.");
  } catch (error) {
    return {
      ok: false,
      notice: errorMessage(error),
      draftBatch: null,
      profileDraft: null,
    };
  }
};

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        <s-text color="subdued">{detail}</s-text>
      </s-stack>
    </s-box>
  );
}

type EngineData = NonNullable<
  ReturnType<typeof useLoaderData<typeof loader>>["engine"]
>;

function DraftCard({
  draft,
  rank,
  profiles,
}: {
  draft: PairingDraft;
  rank: number;
  profiles: EngineData["profiles"];
}) {
  const source = profiles.find(({ handle }) => handle === draft.sourceHandle);
  const target = profiles.find(({ handle }) => handle === draft.targetHandle);
  return (
    <s-box padding="base" border="base" borderRadius="base" blockSize="100%">
      <s-stack
        direction="block"
        gap="base"
        blockSize="100%"
        justifyContent="space-between"
      >
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone="info">Recommendation {rank}</s-badge>
            <s-text color="subdued">
              {draft.generator} · priority {draft.baseWeight}
            </s-text>
          </s-stack>
          <s-grid
            gridTemplateColumns="auto 1fr"
            gap="small"
            alignItems="center"
          >
            {target?.imageUrl ? (
              <s-thumbnail
                src={target.imageUrl}
                alt={target.imageAlt ?? target.title}
                size="base"
              ></s-thumbnail>
            ) : null}
            <s-stack direction="block" gap="small-100">
              <s-heading>{target?.title ?? draft.targetHandle}</s-heading>
              <s-text color="subdued">
                For {source?.title ?? draft.sourceHandle}
              </s-text>
            </s-stack>
          </s-grid>
          <s-paragraph color="subdued">{draft.rationale}</s-paragraph>
        </s-stack>
        <Form method="post">
          <input type="hidden" name="intent" value="publishPairing" />
          <input type="hidden" name="sourceHandle" value={draft.sourceHandle} />
          <input type="hidden" name="targetHandle" value={draft.targetHandle} />
          <input type="hidden" name="relationship" value={draft.relationship} />
          <input type="hidden" name="baseWeight" value={draft.baseWeight} />
          <input type="hidden" name="rationale" value={draft.rationale} />
          <s-button type="submit" variant="primary">
            Approve and publish
          </s-button>
        </Form>
      </s-stack>
    </s-box>
  );
}

function ProductCard({
  product,
  profile,
  action,
  status,
  details,
}: {
  product: EngineData["catalogProducts"][number];
  profile?: EngineData["profiles"][number];
  action?: React.ReactNode;
  status?: React.ReactNode;
  details?: React.ReactNode;
}) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-grid
          gridTemplateColumns="auto 1fr auto"
          gap="base"
          alignItems="center"
        >
          {product.imageUrl ? (
            <s-thumbnail
              src={product.imageUrl}
              alt={product.imageAlt ?? product.title}
              size="large"
            ></s-thumbnail>
          ) : (
            <s-box
              inlineSize="64px"
              blockSize="64px"
              background="subdued"
              borderRadius="base"
            />
          )}
          <s-stack direction="block" gap="small-100">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-heading>{product.title}</s-heading>
              {status}
            </s-stack>
            {profile ? (
              <s-text color="subdued">
                {[
                  merchandisingRoleLabel(profile.role),
                  ...profile.audiences,
                  profile.family,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </s-text>
            ) : (
              <s-text color="subdued">No merchandising profile</s-text>
            )}
          </s-stack>
          {action}
        </s-grid>
        {details}
      </s-stack>
    </s-box>
  );
}

function ProfileAttributes({
  profile,
  popoverId,
}: {
  profile: EngineData["profiles"][number];
  popoverId: string;
}) {
  return (
    <>
      <s-button commandFor={popoverId} command="--toggle">
        View profile attributes
      </s-button>
      <s-popover id={popoverId} maxInlineSize="420px">
        <s-box padding="base">
          <s-stack direction="block" gap="small-200">
            <s-text>
              Role:{" "}
              {profile.role
                ? merchandisingRoleLabel(profile.role)
                : "Unspecified"}
            </s-text>
            <s-text>
              Audience: {profile.audiences.join(", ") || "Unspecified"}
            </s-text>
            <s-text>Family: {profile.family || "Unspecified"}</s-text>
            <s-text>Lifecycle: {profile.lifecycle || "Unspecified"}</s-text>
            <s-text>
              Claims: {profile.claims.join(", ") || "None approved"}
            </s-text>
            <s-text>
              Exclusions: {profile.exclusions.join(", ") || "None"}
            </s-text>
          </s-stack>
        </s-box>
      </s-popover>
    </>
  );
}

function ProductCell({
  product,
  fallback,
}: {
  product?: EngineData["catalogProducts"][number];
  fallback: string;
}) {
  return (
    <s-grid gridTemplateColumns="auto 1fr" gap="small" alignItems="center">
      {product?.imageUrl ? (
        <s-thumbnail
          src={product.imageUrl}
          alt={product.imageAlt ?? product.title}
          size="small"
        ></s-thumbnail>
      ) : null}
      <s-text>{product?.title ?? fallback}</s-text>
    </s-grid>
  );
}

function ProfileDraftCard({
  draft,
  product,
  profileHandle,
  statusLabel = "AI draft",
  submitLabel = "Approve profile",
}: {
  draft: ProfileDraft;
  product: EngineData["catalogProducts"][number];
  profileHandle?: string;
  statusLabel?: string;
  submitLabel?: string;
}) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <Form method="post" data-save-bar>
        <input type="hidden" name="intent" value="publishProfile" />
        <input type="hidden" name="productId" value={draft.productId} />
        <input type="hidden" name="profileHandle" value={profileHandle ?? ""} />
        <s-stack direction="block" gap="base">
          <ProductCard
            product={product}
            status={<s-badge tone="info">{statusLabel}</s-badge>}
          />
          <s-paragraph color="subdued">{draft.rationale}</s-paragraph>
          <s-query-container>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 620px) 1fr, 1fr 1fr"
              gap="base"
            >
              <s-select label="Offer role" name="role" value={draft.role}>
                {MERCHANDISING_ROLE_OPTIONS.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>
              <s-text-field
                label="Audiences"
                details="Comma-separated"
                name="audiences"
                value={draft.audiences.join(", ")}
              ></s-text-field>
              <s-text-field
                label="Product family"
                name="family"
                value={draft.family}
              ></s-text-field>
              <s-text-field
                label="Substitution group"
                name="substitutionGroup"
                value={draft.substitutionGroup ?? ""}
              ></s-text-field>
              <s-text-field
                label="Lifecycle"
                name="lifecycle"
                value={draft.lifecycle}
              ></s-text-field>
              <s-number-field
                label="AI catalog priority"
                details="Orders catalog candidates for AI drafts. Checkout uses pairing priority."
                name="merchantPriority"
                value={String(draft.merchantPriority)}
                min={1}
                max={10}
              ></s-number-field>
              <s-text-field
                label="Approved claims"
                details="Comma-separated; leave empty when none are approved"
                name="claims"
                value={draft.claims.join(", ")}
              ></s-text-field>
              <s-text-field
                label="Exclusions"
                details="Comma-separated"
                name="exclusions"
                value={draft.exclusions.join(", ")}
              ></s-text-field>
            </s-grid>
          </s-query-container>
          <input type="hidden" name="eligible" value="false" />
          <s-switch
            label="Eligible for offers"
            name="eligible"
            value="true"
            defaultChecked={draft.eligible}
          ></s-switch>
          <s-button type="submit" variant="primary">
            {submitLabel}
          </s-button>
        </s-stack>
      </Form>
    </s-box>
  );
}

function exclusionLabel(reason?: string | null) {
  switch (reason) {
    case "unavailable":
      return "Unavailable";
    case "ineligible":
      return "Not eligible for offers";
    case "already_purchased":
      return "Already in this checkout";
    case "same_substitution_group":
      return "Same product family";
    case "no_approved_relation":
      return "No approved pairing";
    case "missing_required_signal":
      return "Required signal unavailable";
    case "missing_profile":
      return "Missing merchandising profile";
    default:
      return "Not eligible";
  }
}

function signalTitle(
  idOrHandle: string,
  profiles: NonNullable<
    ReturnType<typeof useLoaderData<typeof loader>>["engine"]
  >["profiles"],
) {
  return (
    profiles.find(
      (profile) =>
        profile.productId === idOrHandle ||
        profile.productHandle === idOrHandle ||
        profile.handle === idOrHandle,
    )?.title ?? idOrHandle
  );
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [selectedSourceProductId, setSelectedSourceProductId] = useState("");
  const [selectedViewedProductId, setSelectedViewedProductId] = useState("");
  const [selectedRelationHandle, setSelectedRelationHandle] = useState("");
  const [previewRecentView, setPreviewRecentView] = useState(false);
  const [showExclusions, setShowExclusions] = useState(false);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const pendingIntent = String(navigation.formData?.get("intent") ?? "");
  const isGeneratingRecommendations = pendingIntent === "generatePairing";
  const isGeneratingProfile = pendingIntent === "generateProfile";
  const isUpdatingPixel = pendingIntent === "enableRecentView";

  const engine = data.engine;
  const profiles = useMemo(() => engine?.profiles ?? [], [engine]);
  const relations = useMemo(() => engine?.relations ?? [], [engine]);
  const catalogProducts = useMemo(
    () => engine?.catalogProducts ?? [],
    [engine],
  );
  const profileByHandle = useMemo(
    () => new Map(profiles.map((profile) => [profile.handle, profile])),
    [profiles],
  );
  const profileByProductId = useMemo(
    () => new Map(profiles.map((profile) => [profile.productId, profile])),
    [profiles],
  );
  const productById = useMemo(
    () =>
      new Map(catalogProducts.map((product) => [product.productId, product])),
    [catalogProducts],
  );
  const sourceProfiles = useMemo(
    () =>
      profiles.filter((profile) =>
        relations.some((relation) => relation.source === profile.handle),
      ),
    [profiles, relations],
  );
  const defaultSourceProfile = sourceProfiles.find((profile) =>
    productById.has(profile.productId),
  );
  const sourceProductId =
    selectedSourceProductId ||
    defaultSourceProfile?.productId ||
    catalogProducts[0]?.productId ||
    "";
  const sourceProduct = productById.get(sourceProductId);
  const sourceProfile = profileByProductId.get(sourceProductId);
  const sourceProfileDraft: ProfileDraft | undefined = sourceProfile
    ? {
        productId: sourceProfile.productId,
        productHandle: sourceProfile.productHandle,
        title: sourceProfile.title,
        role: sourceProfile.role,
        audiences: sourceProfile.audiences,
        family: sourceProfile.family,
        substitutionGroup: sourceProfile.substitutionGroup,
        lifecycle: sourceProfile.lifecycle,
        claims: sourceProfile.claims,
        exclusions: sourceProfile.exclusions,
        merchantPriority: sourceProfile.merchantPriority,
        eligible: sourceProfile.eligible,
        rationale: "Edit the merchant-approved Shopify custom data.",
        generator: "merchant-approved",
      }
    : undefined;
  const sourceHandle = sourceProfile?.handle ?? "";
  const sourceRelations = relations.filter(
    (relation) => relation.source === sourceHandle && relation.target,
  );
  const selectedRelation =
    sourceRelations.find(
      (relation) => relation.handle === selectedRelationHandle,
    ) ?? sourceRelations[0];
  const selectedTarget = selectedRelation?.target
    ? profileByHandle.get(selectedRelation.target)
    : undefined;
  const viewedProductId =
    selectedViewedProductId || selectedTarget?.productId || "";
  const viewedProduct = productById.get(viewedProductId);
  const viewedProfile = profileByProductId.get(viewedProductId);

  const rankScenario = (recent: boolean) => {
    if (!sourceProfile || !engine) return null;
    return rankOffers({
      purchase: {
        productId: sourceProfile.productId,
        variantId: sourceProfile.variantId,
        productHandle: sourceProfile.productHandle,
      },
      candidates: catalogProducts.map((product) => ({
        productId: product.productId,
        variantId: product.variantId,
        productHandle: product.productHandle,
        available: product.available,
      })),
      profiles,
      relations,
      policy: engine.policy,
      signals: {
        recentlyViewed:
          recent && viewedProduct
            ? [viewedProduct.productId, viewedProduct.productHandle]
            : [],
        purchasedProductIds: [sourceProfile.productId],
      },
    });
  };
  const preview = rankScenario(previewRecentView);
  const winner = preview?.ranked[0];
  const appliedRecentViewBoost = winner?.breakdown.recentlyViewed ?? 0;
  const recentViewMatch = winner?.breakdown.recentViewMatch ?? "none";

  useEffect(() => {
    if (actionData?.notice) shopify.toast.show(actionData.notice);
  }, [actionData, shopify]);

  if (!engine) {
    return (
      <s-page heading="Grüns post-purchase">
        <s-banner tone="critical" heading="The offer engine could not load">
          {data.loadError}
        </s-banner>
      </s-page>
    );
  }
  if (!sourceProduct) {
    return (
      <s-page heading="Grüns post-purchase">
        <s-banner heading="No active products are available">
          Add or publish a Shopify product, then reload the app.
        </s-banner>
      </s-page>
    );
  }
  const selectedSourceProduct = sourceProduct;
  async function choosePurchasedProduct() {
    const picked = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: false,
      selectionIds: [{ id: selectedSourceProduct.productId }],
    });
    const product = picked?.[0];
    if (!product) return;
    if (!productById.has(product.id)) {
      shopify.toast.show("That product is not active in this catalog.");
      return;
    }
    setSelectedSourceProductId(product.id);
    setSelectedRelationHandle("");
    setPreviewRecentView(false);
    setShowExclusions(false);
    setShowProfileEditor(false);
  }

  async function chooseViewedProduct() {
    const picked = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: false,
      ...(viewedProduct
        ? { selectionIds: [{ id: viewedProduct.productId }] }
        : {}),
    });
    const product = picked?.[0];
    if (!product) return;
    if (!productById.has(product.id)) {
      shopify.toast.show("That product is not active in this catalog.");
      return;
    }
    setSelectedViewedProductId(product.id);
    setPreviewRecentView(true);
  }

  const draftBatch = actionData?.draftBatch as
    PairingDraftBatch | null | undefined;
  const profileDraft = actionData?.profileDraft as
    ProfileDraft | null | undefined;
  const visibleDraftBatch = draftBatch?.drafts.every(
    (draft) => draft.sourceHandle === sourceHandle,
  )
    ? draftBatch
    : null;
  const latestDecision = data.decisions[0];
  const latestFeedback = data.decisions.find(
    (decision) => decision.feedbackChoice || decision.feedbackText,
  );

  return (
    <s-page heading="Grüns post-purchase">
      <s-stack direction="block" gap="large">
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">SHOPIFY DEVELOPER CASE STUDY</s-text>
            <s-heading>Grüns post-purchase offers</s-heading>
            <s-paragraph>
              AI-assisted merchandising, deterministic ranking, and one-click
              offers in a Shopify-native app.
            </s-paragraph>
          </s-stack>
        </s-box>

        {actionData && !actionData.ok ? (
          <s-banner tone="critical" heading="The change was not saved">
            {actionData.notice}
          </s-banner>
        ) : null}

        <s-section heading="Shopify Analytics">
          <s-stack direction="block" gap="base">
            {data.shopifyAnalytics.status === "ready" ? (
              <>
                <s-query-container>
                  <s-grid
                    gridTemplateColumns="@container (inline-size <= 600px) 1fr, 1fr 1fr"
                    gap="base"
                  >
                    <Metric
                      label="Shopify total sales"
                      value={"$" + data.shopifyAnalytics.totalSales.toFixed(2)}
                      detail="Last 30 days"
                    />
                    <Metric
                      label="Shopify orders"
                      value={String(data.shopifyAnalytics.orders)}
                      detail="Last 30 days"
                    />
                  </s-grid>
                </s-query-container>

                <s-paragraph color="subdued">
                  ShopifyQL is connected. Shopify excludes development-store
                  test orders, so test outcomes appear in the app metrics below.
                </s-paragraph>
              </>
            ) : (
              <s-banner tone="warning" heading="Connect Shopify Analytics">
                {data.shopifyAnalytics.error}
              </s-banner>
            )}

            <s-heading>Test offer performance</s-heading>
            <s-query-container>
              <s-grid
                gridTemplateColumns="@container (inline-size <= 700px) 1fr, 1fr 1fr 1fr"
                gap="base"
              >
                <Metric
                  label="Offers shown"
                  value={String(data.stats.shown)}
                  detail="Post-purchase impressions"
                />
                <Metric
                  label="Conversion"
                  value={data.stats.conversion + "%"}
                  detail={data.stats.accepted + " accepted"}
                />
                <Metric
                  label="Estimated offer revenue"
                  value={"$" + data.stats.revenue.toFixed(2)}
                  detail="Accepted test offers"
                />
              </s-grid>
            </s-query-container>
          </s-stack>
        </s-section>

        <s-section heading="Decision workspace">
          <s-stack direction="block" gap="large">
            <s-query-container>
              <s-grid
                gridTemplateColumns="@container (inline-size <= 760px) 1fr, 1fr 1fr"
                gap="base"
                alignItems="stretch"
              >
                <s-stack direction="block" gap="small">
                  <s-text color="subdued">PURCHASED PRODUCT</s-text>
                  <ProductCard
                    product={sourceProduct}
                    profile={sourceProfile}
                    status={
                      sourceProfile ? (
                        <s-badge tone="success">Mapped</s-badge>
                      ) : (
                        <s-badge tone="warning">Unmapped</s-badge>
                      )
                    }
                    action={
                      <s-button onClick={choosePurchasedProduct}>
                        Choose
                      </s-button>
                    }
                    details={
                      sourceProfile ? (
                        <s-stack direction="inline" gap="small">
                          <ProfileAttributes
                            profile={sourceProfile}
                            popoverId="source-attributes"
                          />
                          <s-button
                            onClick={() =>
                              setShowProfileEditor(!showProfileEditor)
                            }
                          >
                            {showProfileEditor
                              ? "Close profile editor"
                              : "Edit profile"}
                          </s-button>
                        </s-stack>
                      ) : null
                    }
                  />
                </s-stack>

                <s-stack direction="block" gap="small">
                  <s-grid
                    gridTemplateColumns="1fr auto"
                    gap="small"
                    alignItems="center"
                  >
                    <s-text color="subdued">SIMULATED RECENT VIEW</s-text>
                    <s-badge tone="info">Preview only</s-badge>
                  </s-grid>
                  {viewedProduct ? (
                    <ProductCard
                      product={viewedProduct}
                      profile={viewedProfile}
                      action={
                        <s-button onClick={chooseViewedProduct}>
                          Choose
                        </s-button>
                      }
                      details={
                        <s-stack
                          direction="inline"
                          gap="small"
                          alignItems="center"
                        >
                          {viewedProfile ? (
                            <ProfileAttributes
                              profile={viewedProfile}
                              popoverId="viewed-attributes"
                            />
                          ) : null}
                          <s-switch
                            label={
                              previewRecentView
                                ? "Include recent-view signal"
                                : "Recent-view signal off"
                            }
                            checked={previewRecentView}
                            onChange={(event) =>
                              setPreviewRecentView(event.currentTarget.checked)
                            }
                          ></s-switch>
                        </s-stack>
                      }
                    />
                  ) : (
                    <s-box padding="base" border="base" borderRadius="base">
                      <s-stack direction="block" gap="base">
                        <s-text color="subdued">
                          Add an optional product view to test the intent boost.
                        </s-text>
                        <s-button onClick={chooseViewedProduct}>
                          Choose viewed product
                        </s-button>
                      </s-stack>
                    </s-box>
                  )}
                </s-stack>
              </s-grid>
            </s-query-container>

            <s-text color="subdued">
              This preview uses the selected checkout product and one optional
              recent view. “Already purchased” means already in this checkout;
              customer purchase history is not used in v1.
            </s-text>

            {sourceProfile && sourceProfileDraft && showProfileEditor ? (
              <ProfileDraftCard
                draft={sourceProfileDraft}
                product={sourceProduct}
                profileHandle={sourceProfile.handle}
                statusLabel="Shopify data"
                submitLabel="Save profile"
              />
            ) : null}

            {sourceProfile ? (
              <>
                <s-query-container>
                  <s-grid
                    gridTemplateColumns="@container (inline-size <= 760px) 1fr, 1fr 1fr 1fr 1fr"
                    gap="base"
                    alignItems="stretch"
                  >
                    <s-box
                      padding="base"
                      border="base"
                      borderRadius="base"
                      minBlockSize="148px"
                    >
                      <s-stack direction="block" gap="small-200">
                        <s-text color="subdued">1 · Hard exclusions</s-text>
                        <s-heading>
                          {String(preview?.excluded.length ?? 0)} removed
                        </s-heading>
                        <s-text color="subdued">
                          Availability, purchase, family, and policy rules
                        </s-text>
                        <s-button
                          variant="tertiary"
                          onClick={() => setShowExclusions(!showExclusions)}
                        >
                          {showExclusions
                            ? "Hide exclusions"
                            : "Review exclusions"}
                        </s-button>
                      </s-stack>
                    </s-box>
                    <s-box
                      padding="base"
                      border="base"
                      borderRadius="base"
                      minBlockSize="148px"
                    >
                      <s-stack direction="block" gap="small-200">
                        <s-text color="subdued">2 · Customer intent</s-text>
                        <s-heading>
                          {appliedRecentViewBoost
                            ? "+" + appliedRecentViewBoost
                            : "+0"}
                        </s-heading>
                        <s-text color="subdued">
                          {appliedRecentViewBoost && viewedProduct
                            ? recentViewMatch === "similar"
                              ? `Similar to ${viewedProduct.title}`
                              : viewedProduct.title
                            : previewRecentView && viewedProduct
                              ? "Signal did not change the winner"
                              : "No recent-view signal"}
                        </s-text>
                      </s-stack>
                    </s-box>
                    <s-box
                      padding="base"
                      border="base"
                      borderRadius="base"
                      minBlockSize="148px"
                    >
                      <s-stack direction="block" gap="small-200">
                        <s-text color="subdued">3 · Pairing priority</s-text>
                        <s-heading>
                          {winner
                            ? "+" + winner.breakdown.merchantPairing
                            : "—"}
                        </s-heading>
                        <s-text color="subdued">Merchant-approved, 1–30</s-text>
                      </s-stack>
                    </s-box>
                    <s-box
                      padding="base"
                      border="base"
                      borderRadius="base"
                      minBlockSize="148px"
                    >
                      <s-stack direction="block" gap="small-200">
                        <s-text color="subdued">4 · Outcome</s-text>
                        <s-heading>
                          {winner
                            ? profileByHandle.get(winner.profile.handle)?.title
                            : "No offer"}
                        </s-heading>
                        <s-text color="subdued">
                          {winner
                            ? "Score " + winner.score
                            : "No eligible path"}
                        </s-text>
                      </s-stack>
                    </s-box>
                  </s-grid>
                </s-query-container>

                {winner ? (
                  <s-box padding="base" border="base" borderRadius="base">
                    <s-stack direction="block" gap="base">
                      <s-grid
                        gridTemplateColumns="1fr auto"
                        gap="base"
                        alignItems="center"
                      >
                        <s-stack direction="block" gap="small-100">
                          <s-text color="subdued">BUYER-FACING RESULT</s-text>
                          <s-heading>Post-purchase offer preview</s-heading>
                        </s-stack>
                        <s-badge tone="info">
                          {recentViewMatch === "exact"
                            ? "Exact recent view"
                            : recentViewMatch === "similar"
                              ? "Similar recent view"
                              : "Merchant pairing"}
                        </s-badge>
                      </s-grid>
                      <ProductCard
                        product={
                          productById.get(winner.profile.productId) ??
                          sourceProduct
                        }
                        profile={winner.profile}
                      />
                      <s-paragraph color="subdued">
                        {winner.relation.rationale}
                      </s-paragraph>
                      <s-text color="subdued">
                        Score {winner.score} ·{" "}
                        {winner.breakdown.merchantPairing}
                        {winner.breakdown.recentlyViewed
                          ? ` + ${winner.breakdown.recentlyViewed} intent`
                          : ""}
                        {" · "}
                        {Math.round(winner.relation.maxDiscount * 100)}% offer ·
                        buyer chooses any available variant
                      </s-text>
                    </s-stack>
                  </s-box>
                ) : null}

                {showExclusions ? (
                  <s-table variant="auto">
                    <s-table-header-row>
                      <s-table-header listSlot="primary">
                        Product
                      </s-table-header>
                      <s-table-header>Reason</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {(preview?.excluded ?? []).map((item) => {
                        const product = productById.get(
                          item.candidate.productId,
                        );
                        return (
                          <s-table-row key={item.candidate.productId}>
                            <s-table-cell>
                              <ProductCell
                                product={product}
                                fallback={item.candidate.productHandle}
                              />
                            </s-table-cell>
                            <s-table-cell>
                              {exclusionLabel(item.reason)}
                            </s-table-cell>
                          </s-table-row>
                        );
                      })}
                    </s-table-body>
                  </s-table>
                ) : null}

                <s-query-container>
                  <s-grid
                    gridTemplateColumns="@container (inline-size <= 820px) 1fr, 2fr 3fr"
                    gap="base"
                    alignItems="start"
                  >
                    <s-stack direction="block" gap="small">
                      <s-grid
                        gridTemplateColumns="1fr auto"
                        gap="small"
                        alignItems="center"
                      >
                        <s-heading>Configured offer paths</s-heading>
                        <s-text color="subdued">
                          {sourceRelations.length} total
                        </s-text>
                      </s-grid>
                      <s-box border="base" borderRadius="base">
                        <s-stack direction="block">
                          {sourceRelations.map((relation) => {
                            const target = profileByHandle.get(
                              relation.target ?? "",
                            );
                            const targetProduct = target
                              ? productById.get(target.productId)
                              : undefined;
                            const priority = Math.min(
                              PAIRING_PRIORITY_MAX,
                              Math.max(1, relation.baseWeight),
                            );
                            const rankedCandidate = preview?.ranked.find(
                              (candidate) =>
                                candidate.profile.productId ===
                                target?.productId,
                            );
                            const exclusion = preview?.excluded.find(
                              (item) =>
                                item.candidate.productId === target?.productId,
                            );
                            const needsSignal =
                              relation.requiredSignals.length > 0;
                            const hardExcluded = relationshipBlocksOffer(
                              relation.relationship,
                            );
                            return (
                              <s-clickable
                                key={relation.handle}
                                padding="small-300"
                                border="base"
                                borderStyle="none none solid none"
                                background={
                                  relation.handle === selectedRelation?.handle
                                    ? "subdued"
                                    : "base"
                                }
                                accessibilityLabel={
                                  "Edit " + (target?.title ?? relation.name)
                                }
                                onClick={() =>
                                  setSelectedRelationHandle(relation.handle)
                                }
                              >
                                <s-grid
                                  gridTemplateColumns="auto 1fr auto"
                                  gap="small"
                                  alignItems="center"
                                >
                                  {targetProduct?.imageUrl ? (
                                    <s-thumbnail
                                      src={targetProduct.imageUrl}
                                      alt={
                                        targetProduct.imageAlt ??
                                        targetProduct.title
                                      }
                                      size="base"
                                    ></s-thumbnail>
                                  ) : null}
                                  <s-stack direction="block" gap="small-100">
                                    <s-heading>
                                      {target?.title ?? relation.name}
                                    </s-heading>
                                    <s-text color="subdued">
                                      {relation.relationship.replaceAll(
                                        "_",
                                        " ",
                                      )}{" "}
                                      · {priority} priority ·{" "}
                                      {rankedCandidate
                                        ? `${rankedCandidate.score} preview`
                                        : exclusionLabel(exclusion?.reason)}
                                      {rankedCandidate?.breakdown
                                        .recentViewMatch === "exact"
                                        ? " · exact view"
                                        : rankedCandidate?.breakdown
                                              .recentViewMatch === "similar"
                                          ? " · similar view"
                                          : ""}{" "}
                                      · {Math.round(relation.maxDiscount * 100)}
                                      % off
                                    </s-text>
                                  </s-stack>
                                  <s-badge
                                    tone={
                                      needsSignal ||
                                      hardExcluded ||
                                      !relation.active ||
                                      !rankedCandidate
                                        ? "warning"
                                        : "success"
                                    }
                                  >
                                    {needsSignal
                                      ? "Held"
                                      : hardExcluded
                                        ? "Hard exclusion"
                                        : !relation.active
                                          ? "Paused"
                                          : rankedCandidate
                                            ? "Eligible"
                                            : "Excluded"}
                                  </s-badge>
                                </s-grid>
                              </s-clickable>
                            );
                          })}
                        </s-stack>
                      </s-box>
                    </s-stack>

                    <s-stack direction="block" gap="base">
                      {selectedRelation && selectedTarget ? (
                        <s-box padding="base" border="base" borderRadius="base">
                          <Form
                            key={selectedRelation.handle}
                            method="post"
                            data-save-bar
                          >
                            <input
                              type="hidden"
                              name="intent"
                              value="updateRelation"
                            />
                            <input
                              type="hidden"
                              name="relationHandle"
                              value={selectedRelation.handle}
                            />
                            <s-stack direction="block" gap="base">
                              <ProductCard
                                product={
                                  productById.get(selectedTarget.productId) ??
                                  sourceProduct
                                }
                                profile={selectedTarget}
                              />
                              <s-paragraph color="subdued">
                                {selectedRelation.rationale}
                              </s-paragraph>
                              <s-query-container>
                                <s-grid
                                  gridTemplateColumns="@container (inline-size <= 520px) 1fr, 1fr 1fr"
                                  gap="base"
                                >
                                  <s-number-field
                                    label="Pairing priority"
                                    details="Higher wins after exclusions and intent."
                                    name="baseWeight"
                                    value={String(
                                      Math.min(
                                        PAIRING_PRIORITY_MAX,
                                        Math.max(
                                          1,
                                          selectedRelation.baseWeight,
                                        ),
                                      ),
                                    )}
                                    min={1}
                                    max={PAIRING_PRIORITY_MAX}
                                  ></s-number-field>
                                  <s-number-field
                                    label="Offer discount (%)"
                                    details="Applied inline to the post-purchase item. No discount code is created."
                                    name="maxDiscount"
                                    value={String(
                                      Math.round(
                                        selectedRelation.maxDiscount * 100,
                                      ),
                                    )}
                                    min={0}
                                    max={50}
                                    step={5}
                                  ></s-number-field>
                                </s-grid>
                              </s-query-container>
                              {selectedRelation.requiredSignals.length ? (
                                <s-box
                                  padding="small-300"
                                  background="subdued"
                                  borderRadius="base"
                                >
                                  <s-text>
                                    Not eligible in v1. This path requires{" "}
                                    {selectedRelation.requiredSignals.join(
                                      ", ",
                                    )}
                                    ; the demo only collects recent product
                                    views.
                                  </s-text>
                                </s-box>
                              ) : null}
                              {relationshipBlocksOffer(
                                selectedRelation.relationship,
                              ) ? (
                                <s-box
                                  padding="small-300"
                                  background="subdued"
                                  borderRadius="base"
                                >
                                  <s-text>
                                    Hard exclusion:{" "}
                                    {selectedRelation.relationship.replaceAll(
                                      "_",
                                      " ",
                                    )}{" "}
                                    relations never rank as post-purchase
                                    offers.
                                  </s-text>
                                </s-box>
                              ) : null}
                              <input
                                type="hidden"
                                name="active"
                                value="false"
                              />
                              <s-switch
                                label="Eligible for offers"
                                name="active"
                                value="true"
                                defaultChecked={selectedRelation.active}
                                disabled={relationshipBlocksOffer(
                                  selectedRelation.relationship,
                                )}
                              ></s-switch>
                            </s-stack>
                          </Form>
                        </s-box>
                      ) : (
                        <s-box padding="base" background="subdued">
                          <s-text color="subdued">
                            This product has no approved offer paths yet.
                          </s-text>
                        </s-box>
                      )}
                    </s-stack>
                  </s-grid>
                </s-query-container>
              </>
            ) : (
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-heading>Map this product before ranking it</s-heading>
                  <s-paragraph color="subdued">
                    Generate a merchandising profile, review every field, then
                    approve it before creating offer paths.
                  </s-paragraph>
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="generateProfile"
                    />
                    <input
                      type="hidden"
                      name="productId"
                      value={sourceProduct.productId}
                    />
                    <s-button
                      type="submit"
                      loading={isGeneratingProfile}
                      variant="primary"
                    >
                      Draft merchandising profile
                    </s-button>
                  </Form>
                </s-stack>
              </s-box>
            )}

            {profileDraft &&
            profileDraft.productId === sourceProduct.productId ? (
              <ProfileDraftCard draft={profileDraft} product={sourceProduct} />
            ) : null}

            <s-divider></s-divider>

            <s-stack direction="block" gap="base">
              <s-grid
                gridTemplateColumns="1fr auto"
                gap="base"
                alignItems="center"
              >
                <s-stack direction="block" gap="small-100">
                  <s-heading>AI pairing recommendations</s-heading>
                  <s-text color="subdued">
                    AI drafts catalog data for review. Checkout uses only
                    approved Shopify data.
                  </s-text>
                </s-stack>
                <s-text color="subdued">
                  {data.ai.configured
                    ? data.ai.provider + " · " + data.ai.model
                    : "Local fallback"}{" "}
                  · {data.ai.runs} runs ·{" "}
                  {data.ai.inputTokens + data.ai.outputTokens} tokens · $
                  {data.ai.estimatedCostUsd.toFixed(6)} · {data.ai.shopLimit}
                  /day for this shop
                </s-text>
              </s-grid>
              {sourceProfile ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="generatePairing" />
                  <input
                    type="hidden"
                    name="sourceHandle"
                    value={sourceHandle}
                  />
                  <s-button type="submit" loading={isGeneratingRecommendations}>
                    Generate recommendations
                  </s-button>
                </Form>
              ) : (
                <s-text color="subdued">
                  Approve the merchandising profile to generate pairings.
                </s-text>
              )}
              {visibleDraftBatch ? (
                <s-query-container>
                  <s-grid
                    gridTemplateColumns="@container (inline-size <= 760px) 1fr, 1fr 1fr 1fr"
                    gap="base"
                    alignItems="stretch"
                  >
                    {visibleDraftBatch.drafts.map((draft, index) => (
                      <DraftCard
                        key={draft.sourceHandle + ":" + draft.targetHandle}
                        draft={draft}
                        rank={index + 1}
                        profiles={profiles}
                      />
                    ))}
                  </s-grid>
                </s-query-container>
              ) : null}
            </s-stack>
          </s-stack>
        </s-section>
        <s-section heading="Ranking policy">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              This global policy applies after hard exclusions. Exact views use
              the full weight; similar approved product roles use 75%.
            </s-text>
            <Form method="post" data-save-bar>
              <input type="hidden" name="intent" value="updatePolicy" />
              <s-grid
                gridTemplateColumns="@container (inline-size <= 620px) 1fr, minmax(0, 1fr) auto"
                gap="base"
                alignItems="end"
              >
                <s-number-field
                  label="Recent-view weight"
                  details="Intent boost applied after hard exclusions."
                  name="recentlyViewedWeight"
                  value={String(engine.policy.recentlyViewedWeight)}
                  min={0}
                  max={RECENT_VIEW_BOOST}
                ></s-number-field>
                <s-button type="submit">Save global policy</s-button>
              </s-grid>
            </Form>
          </s-stack>
        </s-section>
        <s-section heading="Recent decisions">
          <s-text color="subdued">
            App Home does not load Shopify customer name, email, or address
            fields. Optional Other feedback is bounded, redacted for obvious
            contact details, and deleted after 30 days. Order links are resolved
            server-side from Shopify checkout tokens.
          </s-text>
          {data.decisions.length ? (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Purchased</s-table-header>
                <s-table-header>Offer</s-table-header>
                <s-table-header>Signal</s-table-header>
                <s-table-header>Score</s-table-header>
                <s-table-header>Outcome</s-table-header>
                <s-table-header>Feedback</s-table-header>
                <s-table-header>Order</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.decisions.map((decision) => (
                  <s-table-row key={decision.id}>
                    <s-table-cell>
                      <ProductCell
                        product={productById.get(
                          profileByHandle.get(decision.sourceHandle)
                            ?.productId ?? "",
                        )}
                        fallback={decision.sourceHandle}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <ProductCell
                        product={productById.get(
                          profileByHandle.get(decision.offerHandle)
                            ?.productId ?? "",
                        )}
                        fallback={decision.offerHandle}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      {decision.recentViewMatch === "exact"
                        ? "Exact view"
                        : decision.recentViewMatch === "similar"
                          ? "Similar view"
                          : "Pairing"}
                    </s-table-cell>
                    <s-table-cell>{decision.score}</s-table-cell>
                    <s-table-cell>{decision.status}</s-table-cell>
                    <s-table-cell>
                      {decision.feedbackChoice
                        ? `${decision.feedbackChoice}${decision.feedbackText ? ` · ${decision.feedbackText}` : ""}`
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      {decision.order ? (
                        <s-button
                          href={`shopify://admin/orders/${decision.order.legacyResourceId}`}
                          target="_top"
                          icon="external"
                          variant="tertiary"
                          accessibilityLabel={`Open ${decision.order.name} in Shopify Admin`}
                        >
                          {decision.order.name}
                        </s-button>
                      ) : (
                        "—"
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          ) : (
            <s-box padding="large" background="subdued" borderRadius="base">
              <s-text color="subdued">
                Complete a test checkout to inspect a recorded decision.
              </s-text>
            </s-box>
          )}
        </s-section>

        <s-section heading="Developer diagnostics">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Product views stay in Shopify’s consent-aware pixel storage until
              checkout starts. Preview changes above do not appear here.
            </s-text>
            <s-query-container>
              <s-grid
                gridTemplateColumns="@container (inline-size <= 760px) 1fr, 1fr 1fr 1fr 1fr"
                gap="base"
              >
                <Metric
                  label="1 · Storefront"
                  value={data.latestIntent ? "Checkout started" : "Waiting"}
                  detail={
                    data.latestIntent?.recentlyViewed.length
                      ? data.latestIntent.recentlyViewed
                          .map((value) => signalTitle(value, profiles))
                          .join(", ")
                      : "Browse a product, then start checkout"
                  }
                />
                <Metric
                  label="2 · Exact join"
                  value={
                    data.signalJoin === "exact"
                      ? "Matched"
                      : data.signalJoin === "unmatched"
                        ? "No match"
                        : "Not needed"
                  }
                  detail={
                    data.latestIntent
                      ? `Checkout ${data.latestIntent.checkoutToken}`
                      : "No checkout token"
                  }
                />
                <Metric
                  label="3 · Ranked offer"
                  value={
                    latestDecision
                      ? (profileByHandle.get(latestDecision.offerHandle)
                          ?.title ?? latestDecision.offerHandle)
                      : "No decision"
                  }
                  detail={
                    latestDecision
                      ? `Score ${latestDecision.score}`
                      : "Use the preview above"
                  }
                />
                <Metric
                  label="4 · Buyer outcome"
                  value={latestDecision?.status ?? "Waiting"}
                  detail={
                    latestFeedback
                      ? `Feedback: ${latestFeedback.feedbackChoice}${latestFeedback.feedbackText ? ` · ${latestFeedback.feedbackText}` : ""}`
                      : "No feedback yet"
                  }
                />
              </s-grid>
            </s-query-container>
            {!data.pixelEnabled ? (
              <Form method="post">
                <input type="hidden" name="intent" value="enableRecentView" />
                <s-button type="submit" loading={isUpdatingPixel}>
                  Enable Web Pixel
                </s-button>
              </Form>
            ) : null}
          </s-stack>
        </s-section>
        {data.privacyRequests.length ? (
          <s-section heading="Customer data requests">
            <s-stack direction="block" gap="base">
              <s-banner tone="warning" heading="Export requested customer data">
                Download each JSON file and provide it to the store owner within
                Shopify’s 30-day response window. Exports expire after 30 days.
              </s-banner>
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Customer</s-table-header>
                  <s-table-header>Requested</s-table-header>
                  <s-table-header>Export</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.privacyRequests.map((privacyRequest) => (
                    <s-table-row key={privacyRequest.id}>
                      <s-table-cell>{privacyRequest.customerId}</s-table-cell>
                      <s-table-cell>
                        {new Date(
                          privacyRequest.createdAt,
                        ).toLocaleDateString()}
                      </s-table-cell>
                      <s-table-cell>
                        <s-link
                          href={`/app/privacy-request/${privacyRequest.id}`}
                          target="_blank"
                        >
                          Download JSON
                        </s-link>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
