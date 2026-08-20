import type {
  MerchandisingCatalogProduct,
  MerchandisingEngine,
} from "./merchandising.server";
import prisma from "../db.server";
import { estimateAiCost } from "./ai-cost.mjs";
import {
  aiRunAllowed,
  boundedAiLimit,
  buildFallbackProfile,
  findUnmappedProduct,
  normalizeProfileDraft,
} from "./ai-profile.mjs";
import { MERCHANDISING_ROLES } from "./merchandising-vocabulary.mjs";

const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_OUTPUT_TOKENS = 800;
const DEFAULT_DAILY_RUNS = 20;
const DEFAULT_GLOBAL_DAILY_RUNS = 100;
const MAX_RECOMMENDATIONS = 3;
const MAX_PRIORITY = 30;

export const RELATIONSHIPS = [
  "functional_accessory",
  "brand_accessory",
  "household_complement",
] as const;

export type PairingDraft = {
  sourceHandle: string;
  targetHandle: string;
  relationship: (typeof RELATIONSHIPS)[number];
  baseWeight: number;
  rationale: string;
  generator: string;
};

export type PairingDraftBatch = {
  drafts: PairingDraft[];
  provider: string;
  model: string;
  candidateCount: number;
  outcomeCount: number;
};

export type ProfileDraft = {
  productId: string;
  productHandle: string;
  title: string;
  role: string;
  audiences: string[];
  family: string;
  substitutionGroup?: string;
  lifecycle: string;
  claims: string[];
  exclusions: string[];
  merchantPriority: number;
  eligible: boolean;
  rationale: string;
  generator: string;
};

type OutcomeContext = {
  offerHandle: string;
  shown: number;
  accepted: number;
  declined: number;
  feedback: Record<string, number>;
};

type ProviderUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

function providerConfig() {
  const apiKey = process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.AI_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/$/,
    "",
  );
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;
  let provider = "OpenAI";
  try {
    if (new URL(baseUrl).hostname.includes("openrouter")) {
      provider = "OpenRouter";
    } else if (baseUrl !== DEFAULT_BASE_URL) {
      provider = new URL(baseUrl).hostname;
    }
  } catch {
    provider = "Configured provider";
  }
  return { apiKey, baseUrl, model, provider };
}

function aiLimits() {
  return {
    shopLimit: boundedAiLimit(
      process.env.AI_DAILY_SHOP_LIMIT,
      DEFAULT_DAILY_RUNS,
      100,
    ),
    globalLimit: boundedAiLimit(
      process.env.AI_DAILY_GLOBAL_LIMIT,
      DEFAULT_GLOBAL_DAILY_RUNS,
      500,
    ),
  };
}

export function aiProviderStatus() {
  const { apiKey, model, provider } = providerConfig();
  return { configured: Boolean(apiKey), model, provider, ...aiLimits() };
}

function candidatePool(engine: MerchandisingEngine, sourceHandle: string) {
  const source = engine.profiles.find(
    (profile) => profile.handle === sourceHandle,
  );
  if (!source) throw new Error("Choose a purchased product first.");

  const candidates = engine.profiles
    .filter(
      (profile) =>
        profile.handle !== source.handle &&
        profile.eligible &&
        profile.available &&
        profile.substitutionGroup !== source.substitutionGroup,
    )
    .sort((left, right) => right.merchantPriority - left.merchantPriority)
    .slice(0, 6);
  if (!candidates.length) {
    throw new Error("No eligible complementary products are available.");
  }
  return { source, candidates };
}

function fallbackDrafts(
  source: MerchandisingEngine["profiles"][number],
  candidates: MerchandisingEngine["profiles"],
): PairingDraft[] {
  return candidates.slice(0, MAX_RECOMMENDATIONS).map((target) => ({
    sourceHandle: source.handle,
    targetHandle: target.handle,
    relationship: ["carry", "hydration", "routine_accessory"].includes(
      target.role,
    )
      ? "functional_accessory"
      : "brand_accessory",
    baseWeight: Math.min(
      MAX_PRIORITY,
      Math.max(1, target.merchantPriority * 2),
    ),
    rationale: `${target.title} complements ${source.title} without repeating the purchased nutrition format.`,
    generator: "local-fallback",
  }));
}

function outputText(payload: {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}) {
  return (
    payload.output_text ??
    payload.output
      ?.flatMap((item) => item.content ?? [])
      .find((item) => item.type === "output_text")?.text
  );
}

async function reserveDailyRun(shop: string) {
  const date = new Date().toISOString().slice(0, 10);
  const { shopLimit, globalLimit } = aiLimits();
  return prisma.$transaction(async (transaction) => {
    const [usage, globalUsage] = await Promise.all([
      transaction.aiDailyUsage.findUnique({
        where: { shop_date: { shop, date } },
      }),
      transaction.aiDailyUsage.aggregate({
        where: { date },
        _sum: { runs: true },
      }),
    ]);
    if (
      !aiRunAllowed(
        usage?.runs ?? 0,
        globalUsage._sum.runs ?? 0,
        shopLimit,
        globalLimit,
      )
    ) {
      return null;
    }

    await transaction.aiDailyUsage.upsert({
      where: { shop_date: { shop, date } },
      create: { shop, date, runs: 1 },
      update: { runs: { increment: 1 } },
    });
    return date;
  });
}

async function recordUsage(
  shop: string,
  date: string,
  provider: string,
  model: string,
  usage: ProviderUsage,
) {
  await prisma.aiDailyUsage.update({
    where: { shop_date: { shop, date } },
    data: {
      inputTokens: { increment: usage.inputTokens },
      cachedInputTokens: { increment: usage.cachedInputTokens },
      outputTokens: { increment: usage.outputTokens },
      estimatedCostUsd: { increment: usage.estimatedCostUsd },
      lastProvider: provider,
      lastModel: model,
    },
  });
}

async function outcomeContext(shop: string, sourceHandle: string) {
  const decisions = await prisma.offerDecision.findMany({
    where: { shop, sourceHandle },
    select: {
      offerHandle: true,
      shownAt: true,
      status: true,
      feedbackChoice: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const byOffer = new Map<string, OutcomeContext>();
  for (const decision of decisions) {
    const current = byOffer.get(decision.offerHandle) ?? {
      offerHandle: decision.offerHandle,
      shown: 0,
      accepted: 0,
      declined: 0,
      feedback: {},
    };
    if (decision.shownAt) current.shown += 1;
    if (decision.status === "accepted") current.accepted += 1;
    if (decision.status === "declined") current.declined += 1;
    if (decision.feedbackChoice) {
      current.feedback[decision.feedbackChoice] =
        (current.feedback[decision.feedbackChoice] ?? 0) + 1;
    }
    byOffer.set(decision.offerHandle, current);
  }
  return { outcomes: [...byOffer.values()], count: decisions.length };
}

export async function generatePairingDrafts(
  engine: MerchandisingEngine,
  sourceHandle: string,
  shop: string,
): Promise<PairingDraftBatch> {
  const { source, candidates } = candidatePool(engine, sourceHandle);
  const fallback = fallbackDrafts(source, candidates);
  const { outcomes, count: outcomeCount } = await outcomeContext(
    shop,
    sourceHandle,
  );
  const { apiKey, baseUrl, model, provider } = providerConfig();
  if (!apiKey) {
    return {
      drafts: fallback,
      provider: "Local fallback",
      model: "deterministic",
      candidateCount: candidates.length,
      outcomeCount,
    };
  }
  const date = await reserveDailyRun(shop);
  if (!date)
    throw new Error(
      `Daily AI draft limit (${aiLimits().shopLimit}) reached. Try again tomorrow.`,
    );

  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        instructions:
          "Return up to three distinct complementary Shopify post-purchase recommendations, best first. Use only supplied target handles. Never suggest a nutrition substitute or a purchased product. Pairing priority must be 1 to 30. Give each recommendation one plain merchant-facing sentence explaining why it fits. Treat aggregate outcomes as weak evidence, not permission to repeat a poor offer.",
        input: JSON.stringify({
          source: {
            handle: source.handle,
            title: source.title.slice(0, 120),
            audiences: source.audiences.slice(0, 5),
            family: source.family.slice(0, 80),
          },
          candidates: candidates.map((candidate) => {
            const existing = engine.relations.find(
              (relation) =>
                relation.source === source.handle &&
                relation.target === candidate.handle,
            );
            return {
              handle: candidate.handle,
              title: candidate.title.slice(0, 120),
              role: candidate.role.slice(0, 80),
              audiences: candidate.audiences.slice(0, 5),
              family: candidate.family.slice(0, 80),
              merchantPriority: candidate.merchantPriority,
              existingPairingPriority: existing?.baseWeight,
              existingReason: existing?.rationale.slice(0, 200),
            };
          }),
          aggregateOutcomes: outcomes,
        }),
        text: {
          format: {
            type: "json_schema",
            name: "pairing_recommendations",
            strict: true,
            schema: {
              type: "object",
              properties: {
                recommendations: {
                  type: "array",
                  minItems: 1,
                  maxItems: MAX_RECOMMENDATIONS,
                  items: {
                    type: "object",
                    properties: {
                      targetHandle: {
                        type: "string",
                        enum: candidates.map(({ handle }) => handle),
                      },
                      relationship: { type: "string", enum: RELATIONSHIPS },
                      pairingPriority: {
                        type: "integer",
                        minimum: 1,
                        maximum: MAX_PRIORITY,
                      },
                      reason: {
                        type: "string",
                        minLength: 1,
                        maxLength: 200,
                      },
                    },
                    required: [
                      "targetHandle",
                      "relationship",
                      "pairingPriority",
                      "reason",
                    ],
                    additionalProperties: false,
                  },
                },
              },
              required: ["recommendations"],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    if (!response.ok) {
      return {
        drafts: fallback,
        provider: "Local fallback",
        model: "deterministic",
        candidateCount: candidates.length,
        outcomeCount,
      };
    }

    const payload = (await response.json()) as {
      output_text?: string;
      output?: Array<{
        content?: Array<{ type?: string; text?: string }>;
      }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        cost?: number;
      };
    };
    const inputTokens = payload.usage?.input_tokens ?? 0;
    const cachedInputTokens =
      payload.usage?.input_tokens_details?.cached_tokens ?? 0;
    const outputTokens = payload.usage?.output_tokens ?? 0;
    await recordUsage(shop, date, provider, model, {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      estimatedCostUsd: estimateAiCost({
        model,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        providerCost: payload.usage?.cost,
      }),
    });

    const parsed = JSON.parse(outputText(payload) ?? "") as {
      recommendations?: Array<{
        targetHandle: string;
        relationship: (typeof RELATIONSHIPS)[number];
        pairingPriority: number;
        reason: string;
      }>;
    };
    const candidateHandles = new Set(candidates.map(({ handle }) => handle));
    const seen = new Set<string>();
    const drafts = (parsed.recommendations ?? [])
      .filter((recommendation) => {
        if (
          !candidateHandles.has(recommendation.targetHandle) ||
          seen.has(recommendation.targetHandle) ||
          !RELATIONSHIPS.includes(recommendation.relationship) ||
          !Number.isInteger(recommendation.pairingPriority) ||
          !recommendation.reason?.trim()
        ) {
          return false;
        }
        seen.add(recommendation.targetHandle);
        return true;
      })
      .slice(0, MAX_RECOMMENDATIONS)
      .map((recommendation) => ({
        sourceHandle: source.handle,
        targetHandle: recommendation.targetHandle,
        relationship: recommendation.relationship,
        baseWeight: Math.min(
          MAX_PRIORITY,
          Math.max(1, recommendation.pairingPriority),
        ),
        rationale: recommendation.reason.trim().slice(0, 200),
        generator: `${provider} · ${model}`,
      }));

    return {
      drafts: drafts.length ? drafts : fallback,
      provider,
      model,
      candidateCount: candidates.length,
      outcomeCount,
    };
  } catch {
    return {
      drafts: fallback,
      provider: "Local fallback",
      model: "deterministic",
      candidateCount: candidates.length,
      outcomeCount,
    };
  }
}

export async function generateProfileDraft(
  engine: MerchandisingEngine,
  productId: string,
  shop: string,
): Promise<ProfileDraft> {
  const product = findUnmappedProduct(
    engine.catalogProducts,
    engine.profiles,
    productId,
  ) as MerchandisingCatalogProduct;

  const fallback = buildFallbackProfile(product) as ProfileDraft;
  const { apiKey, baseUrl, model, provider } = providerConfig();
  if (!apiKey) return fallback;

  const date = await reserveDailyRun(shop);
  if (!date)
    throw new Error(
      `Daily AI draft limit (${aiLimits().shopLimit}) reached. Try again tomorrow.`,
    );

  const vocabulary = {
    roles: MERCHANDISING_ROLES,
    audiences: [
      ...new Set(engine.profiles.flatMap(({ audiences }) => audiences)),
    ],
    lifecycles: [
      ...new Set(
        engine.profiles.map(({ lifecycle }) => lifecycle).filter(Boolean),
      ),
    ],
    exclusions: [
      ...new Set(engine.profiles.flatMap(({ exclusions }) => exclusions)),
    ],
  };

  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        instructions:
          "Draft one conservative merchandising profile for merchant review. Use the supplied vocabulary where it fits. Do not invent health claims. Keep each list short. The reason must be one plain merchant-facing sentence.",
        input: JSON.stringify({
          product: {
            id: product.productId,
            handle: product.productHandle,
            title: product.title.slice(0, 120),
            description: product.description.slice(0, 800),
            tags: product.tags.slice(0, 12),
            productType: product.productType.slice(0, 80),
          },
          approvedVocabulary: vocabulary,
        }),
        text: {
          format: {
            type: "json_schema",
            name: "merchandising_profile",
            strict: true,
            schema: {
              type: "object",
              properties: {
                role: { type: "string", enum: MERCHANDISING_ROLES },
                audiences: {
                  type: "array",
                  minItems: 1,
                  maxItems: 5,
                  items: { type: "string", minLength: 1, maxLength: 80 },
                },
                family: { type: "string", minLength: 1, maxLength: 80 },
                substitutionGroup: { type: ["string", "null"], maxLength: 80 },
                lifecycle: { type: "string", minLength: 1, maxLength: 80 },
                claims: {
                  type: "array",
                  maxItems: 5,
                  items: { type: "string", minLength: 1, maxLength: 120 },
                },
                exclusions: {
                  type: "array",
                  minItems: 1,
                  maxItems: 5,
                  items: { type: "string", minLength: 1, maxLength: 80 },
                },
                merchantPriority: {
                  type: "integer",
                  minimum: 1,
                  maximum: 10,
                },
                eligible: { type: "boolean" },
                reason: { type: "string", minLength: 1, maxLength: 200 },
              },
              required: [
                "role",
                "audiences",
                "family",
                "substitutionGroup",
                "lifecycle",
                "claims",
                "exclusions",
                "merchantPriority",
                "eligible",
                "reason",
              ],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    if (!response.ok) return fallback;

    const payload = (await response.json()) as {
      output_text?: string;
      output?: Array<{
        content?: Array<{ type?: string; text?: string }>;
      }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        cost?: number;
      };
    };
    const inputTokens = payload.usage?.input_tokens ?? 0;
    const cachedInputTokens =
      payload.usage?.input_tokens_details?.cached_tokens ?? 0;
    const outputTokens = payload.usage?.output_tokens ?? 0;
    await recordUsage(shop, date, provider, model, {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      estimatedCostUsd: estimateAiCost({
        model,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        providerCost: payload.usage?.cost,
      }),
    });

    const parsed = JSON.parse(outputText(payload) ?? "") as {
      role?: string;
      audiences?: string[];
      family?: string;
      substitutionGroup?: string | null;
      lifecycle?: string;
      claims?: string[];
      exclusions?: string[];
      merchantPriority?: number;
      eligible?: boolean;
      reason?: string;
    };
    return normalizeProfileDraft(
      parsed,
      product,
      `${provider} · ${model}`,
    ) as ProfileDraft;
  } catch {
    return fallback;
  }
}
