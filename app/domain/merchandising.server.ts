import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const ENGINE_QUERY = `#graphql
  query MerchandisingEngine {
    profiles: metaobjects(type: "$app:merchandising_profile", first: 100) {
      nodes { id handle values }
    }
    relations: metaobjects(type: "$app:offer_relation", first: 100) {
      nodes { id handle values }
    }
    policies: metaobjects(type: "$app:ranking_policy", first: 10) {
      nodes { id handle values }
    }
    products(first: 100, query: "status:active") {
      pageInfo { hasNextPage }
      nodes {
        id
        handle
        title
        description
        tags
        productType
        status
        featuredMedia {
          preview { image { url altText } }
        }
        variants(first: 100) {
          nodes {
            id
            legacyResourceId
            title
            availableForSale
            price
            selectedOptions { name value }
          }
        }
      }
    }
  }
`;

const UPSERT_MUTATION = `#graphql
  mutation UpsertMetaobject($handle: MetaobjectHandleInput!, $values: JSON!) {
    metaobjectUpsert(handle: $handle, values: $values) {
      metaobject { id handle type values }
      userErrors { field message code }
    }
  }
`;

type MetaobjectNode = {
  id: string;
  handle: string;
  values: Record<string, unknown>;
};

type ProductNode = {
  id: string;
  handle: string;
  title: string;
  description: string;
  tags: string[];
  productType: string;
  status: string;
  featuredMedia?: {
    preview?: {
      image?: { url: string; altText?: string | null } | null;
    } | null;
  } | null;
  variants: {
    nodes: Array<{
      id: string;
      legacyResourceId: string;
      title: string;
      availableForSale: boolean;
      price: string;
      selectedOptions: Array<{ name: string; value: string }>;
    }>;
  };
};

export type MerchandisingVariant = {
  id: string;
  legacyResourceId: string;
  title: string;
  available: boolean;
  price: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

type EngineQueryData = {
  profiles: { nodes: MetaobjectNode[] };
  relations: { nodes: MetaobjectNode[] };
  policies: { nodes: MetaobjectNode[] };
  products: { nodes: ProductNode[]; pageInfo: { hasNextPage: boolean } };
};

export type MerchandisingProfile = {
  id: string;
  handle: string;
  productId: string;
  productHandle: string;
  title: string;
  variantId?: string;
  legacyVariantId?: string;
  available: boolean;
  description: string;
  imageUrl?: string;
  imageAlt?: string;
  price?: string;
  variants: MerchandisingVariant[];
  role: string;
  audiences: string[];
  family: string;
  substitutionGroup?: string;
  lifecycle: string;
  claims: string[];
  exclusions: string[];
  merchantPriority: number;
  eligible: boolean;
};

export type MerchandisingCatalogProduct = {
  productId: string;
  productHandle: string;
  title: string;
  description: string;
  tags: string[];
  productType: string;
  variantId?: string;
  legacyVariantId?: string;
  available: boolean;
  imageUrl?: string;
  imageAlt?: string;
  price?: string;
  variants: MerchandisingVariant[];
};

export type OfferRelation = {
  id: string;
  handle: string;
  name: string;
  source: string;
  target?: string;
  actionKey?: string;
  relationship: string;
  baseWeight: number;
  rationale: string;
  active: boolean;
  maxDiscount: number;
  requiredSignals: string[];
};

export type RankingPolicy = {
  handle: string;
  name: string;
  version: number;
  recentlyViewedWeight: number;
};

export type MerchandisingEngine = {
  catalogProducts: MerchandisingCatalogProduct[];
  profiles: MerchandisingProfile[];
  relations: OfferRelation[];
  policy: RankingPolicy;
};

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function request<T>(
  admin: AdminApiContext,
  query: string,
  variables?: object,
) {
  const response = await admin.graphql(query, { variables });
  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length || !payload.data) {
    throw new Error(
      payload.errors?.map(({ message }) => message).join("; ") ||
        "Shopify returned no data.",
    );
  }
  return payload.data;
}

export async function loadMerchandisingEngine(
  admin: AdminApiContext,
): Promise<MerchandisingEngine> {
  const data = await request<EngineQueryData>(admin, ENGINE_QUERY);
  if (data.products.pageInfo.hasNextPage) {
    throw new Error(
      "The active catalog exceeds the 100-product case-study limit.",
    );
  }
  const productsById = new Map(
    data.products.nodes.map((product) => [product.id, product]),
  );
  const catalogProducts = data.products.nodes.map((product) => ({
    ...(() => {
      const variants = product.variants.nodes.map((variant) => ({
        id: variant.id,
        legacyResourceId: variant.legacyResourceId,
        title: variant.title,
        available: variant.availableForSale,
        price: variant.price,
        selectedOptions: variant.selectedOptions,
      }));
      const defaultVariant =
        variants.find((variant) => variant.available) ?? variants[0];
      return {
        variantId: defaultVariant?.id,
        legacyVariantId: defaultVariant?.legacyResourceId,
        available: variants.some((variant) => variant.available),
        price: defaultVariant?.price,
        variants,
      };
    })(),
    productId: product.id,
    productHandle: product.handle,
    title: product.title,
    description: product.description,
    tags: product.tags,
    productType: product.productType,
    imageUrl: product.featuredMedia?.preview?.image?.url,
    imageAlt: product.featuredMedia?.preview?.image?.altText ?? product.title,
  }));

  const profiles = data.profiles.nodes.map((node) => {
    const productId = text(node.values.product);
    const product = productsById.get(productId);
    const variants =
      product?.variants.nodes.map((variant) => ({
        id: variant.id,
        legacyResourceId: variant.legacyResourceId,
        title: variant.title,
        available: variant.availableForSale,
        price: variant.price,
        selectedOptions: variant.selectedOptions,
      })) ?? [];
    const defaultVariant =
      variants.find((variant) => variant.available) ?? variants[0];
    return {
      id: node.id,
      handle: node.handle,
      productId,
      productHandle: product?.handle ?? node.handle,
      title: product?.title ?? text(node.values.name, node.handle),
      variantId: defaultVariant?.id,
      legacyVariantId: defaultVariant?.legacyResourceId,
      available: variants.some((variant) => variant.available),
      description: product?.description ?? "",
      imageUrl: product?.featuredMedia?.preview?.image?.url,
      imageAlt:
        product?.featuredMedia?.preview?.image?.altText ?? product?.title,
      price: defaultVariant?.price,
      variants,
      role: text(node.values.role),
      audiences: strings(node.values.audiences),
      family: text(node.values.family),
      substitutionGroup: text(node.values.substitution_group) || undefined,
      lifecycle: text(node.values.lifecycle),
      claims: strings(node.values.claims),
      exclusions: strings(node.values.exclusions),
      merchantPriority: number(node.values.merchant_priority),
      eligible: boolean(node.values.eligible),
    };
  });
  const profileHandleById = new Map(
    profiles.map((profile) => [profile.id, profile.handle]),
  );

  const relations = data.relations.nodes.map((node) => ({
    id: node.id,
    handle: node.handle,
    name: text(node.values.name, node.handle),
    source:
      profileHandleById.get(text(node.values.source_profile)) ?? "unknown",
    target: profileHandleById.get(text(node.values.target_profile)),
    actionKey: text(node.values.action_key) || undefined,
    relationship: text(node.values.relationship),
    baseWeight: number(node.values.base_weight),
    rationale: text(node.values.rationale),
    active: boolean(node.values.active),
    maxDiscount: number(node.values.max_discount),
    requiredSignals: strings(node.values.required_signals),
  }));

  const policyNode = data.policies.nodes[0];
  if (!policyNode) throw new Error("The ranking policy is missing.");
  const policy = {
    handle: policyNode.handle,
    name: text(policyNode.values.name, policyNode.handle),
    version: number(policyNode.values.version, 1),
    recentlyViewedWeight: Math.min(
      40,
      Math.max(0, number(policyNode.values.recently_viewed_weight)),
    ),
  };

  return { catalogProducts, profiles, relations, policy };
}

type ProfileInput = Omit<
  MerchandisingProfile,
  | "id"
  | "title"
  | "description"
  | "imageUrl"
  | "imageAlt"
  | "price"
  | "variantId"
  | "legacyVariantId"
  | "variants"
  | "available"
  | "productHandle"
> & { name: string };

export async function upsertMerchandisingProfile(
  admin: AdminApiContext,
  input: ProfileInput,
) {
  const data = await request<{
    metaobjectUpsert: {
      metaobject: MetaobjectNode | null;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, UPSERT_MUTATION, {
    handle: { type: "$app:merchandising_profile", handle: input.handle },
    values: {
      name: input.name,
      product: input.productId,
      role: input.role,
      audiences: input.audiences,
      family: input.family,
      ...(input.substitutionGroup
        ? { substitution_group: input.substitutionGroup }
        : {}),
      lifecycle: input.lifecycle,
      ...(input.claims.length ? { claims: input.claims } : {}),
      exclusions: input.exclusions,
      merchant_priority: input.merchantPriority,
      eligible: input.eligible,
    },
  });
  if (
    data.metaobjectUpsert.userErrors.length ||
    !data.metaobjectUpsert.metaobject
  ) {
    throw new Error(
      data.metaobjectUpsert.userErrors
        .map(({ message }) => message)
        .join("; ") || "Shopify did not save the merchandising profile.",
    );
  }
  return data.metaobjectUpsert.metaobject;
}

export async function upsertRankingPolicy(
  admin: AdminApiContext,
  policy: RankingPolicy,
) {
  const data = await request<{
    metaobjectUpsert: {
      metaobject: MetaobjectNode | null;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, UPSERT_MUTATION, {
    handle: { type: "$app:ranking_policy", handle: policy.handle },
    values: {
      name: policy.name,
      version: policy.version,
      recently_viewed_weight: policy.recentlyViewedWeight,
    },
  });
  if (
    data.metaobjectUpsert.userErrors.length ||
    !data.metaobjectUpsert.metaobject
  ) {
    throw new Error(
      data.metaobjectUpsert.userErrors
        .map(({ message }) => message)
        .join("; ") || "Shopify did not save the ranking policy.",
    );
  }
  return data.metaobjectUpsert.metaobject;
}

type RelationInput = Omit<OfferRelation, "id">;

export async function upsertOfferRelation(
  admin: AdminApiContext,
  engine: MerchandisingEngine,
  relation: RelationInput,
) {
  const profilesByHandle = new Map(
    engine.profiles.map((profile) => [profile.handle, profile]),
  );
  const source = profilesByHandle.get(relation.source);
  const target = relation.target
    ? profilesByHandle.get(relation.target)
    : undefined;
  if (!source || (relation.target && !target)) {
    throw new Error("The selected relation references a missing profile.");
  }

  const data = await request<{
    metaobjectUpsert: {
      metaobject: MetaobjectNode | null;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, UPSERT_MUTATION, {
    handle: { type: "$app:offer_relation", handle: relation.handle },
    values: {
      name: relation.name,
      source_profile: source.id,
      ...(target
        ? { target_profile: target.id }
        : { action_key: relation.actionKey }),
      relationship: relation.relationship,
      base_weight: relation.baseWeight,
      rationale: relation.rationale,
      active: relation.active,
      max_discount: relation.maxDiscount,
      ...(relation.requiredSignals.length
        ? { required_signals: relation.requiredSignals }
        : {}),
    },
  });
  if (
    data.metaobjectUpsert.userErrors.length ||
    !data.metaobjectUpsert.metaobject
  ) {
    throw new Error(
      data.metaobjectUpsert.userErrors
        .map(({ message }) => message)
        .join("; ") || "Shopify did not save the relation.",
    );
  }
  return data.metaobjectUpsert.metaobject;
}
