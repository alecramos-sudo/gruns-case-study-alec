import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

const API_VERSION = "2026-07";
const DEFAULT_STORE = "gruns-case-study.myshopify.com";
const REQUIRED_SCOPES = new Set([
  "read_products",
  "read_metaobjects",
  "read_metaobject_definitions",
  "write_metaobjects",
]);
const EXPECTED_DEFINITIONS = new Map([
  [
    "merchandising_profile",
    {
      name: "Merchandising profile",
      keys: [
        "name",
        "product",
        "role",
        "audiences",
        "family",
        "substitution_group",
        "lifecycle",
        "claims",
        "exclusions",
        "merchant_priority",
        "eligible",
      ],
    },
  ],
  [
    "offer_relation",
    {
      name: "Offer relation",
      keys: [
        "name",
        "source_profile",
        "target_profile",
        "action_key",
        "relationship",
        "base_weight",
        "rationale",
        "active",
        "max_discount",
        "required_signals",
      ],
    },
  ],
  [
    "ranking_policy",
    {
      name: "Ranking policy",
      keys: [
        "name",
        "version",
        "recently_viewed_weight",
      ],
    },
  ],
]);

const PRODUCT_QUERY = `
  query CatalogProducts($first: Int!) {
    products(first: $first) {
      nodes { id handle }
    }
  }
`;

const UPSERT_MUTATION = `
  mutation UpsertMetaobject($handle: MetaobjectHandleInput!, $values: JSON!) {
    metaobjectUpsert(handle: $handle, values: $values) {
      metaobject { id handle type values }
      userErrors { field message code }
    }
  }
`;

const METAOBJECTS_QUERY = `
  query SeededMetaobjects($type: String!, $first: Int!) {
    metaobjects(type: $type, first: $first) {
      nodes { id handle type values }
    }
  }
`;

const APP_SCOPES_QUERY = `
  query CurrentAppScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

const DEFINITIONS_QUERY = `
  query AppMetaobjectDefinitions($first: Int!) {
    metaobjectDefinitions(first: $first) {
      nodes {
        type
        name
        fieldDefinitions { key }
      }
    }
  }
`;

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const store = readArg("--store", DEFAULT_STORE);
const apply = process.argv.includes("--apply");

if (apply && store !== DEFAULT_STORE) {
  throw new Error(
    `Refusing to mutate ${store}. This seed is locked to ${DEFAULT_STORE}.`,
  );
}

const fixture = JSON.parse(
  await readFile(resolve("data/merchandising.json"), "utf8"),
);

function validateFixture() {
  const profileHandles = new Set(fixture.profiles.map(({ handle }) => handle));
  if (profileHandles.size !== fixture.profiles.length) {
    throw new Error("Merchandising profile handles must be unique.");
  }

  const relationHandles = new Set(
    fixture.relations.map(({ handle }) => handle),
  );
  if (relationHandles.size !== fixture.relations.length) {
    throw new Error("Offer relation handles must be unique.");
  }

  for (const relation of fixture.relations) {
    if (!profileHandles.has(relation.source)) {
      throw new Error(`Unknown relation source: ${relation.source}`);
    }
    if (relation.target && !profileHandles.has(relation.target)) {
      throw new Error(`Unknown relation target: ${relation.target}`);
    }
    if (!relation.target && !relation.actionKey) {
      throw new Error(
        `Relation ${relation.handle} needs a target or action key.`,
      );
    }
  }
}

validateFixture();

const prisma = new PrismaClient();

async function graphql(accessToken, query, variables = {}) {
  const response = await fetch(
    `https://${store}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const payload = await response.json();

  if (!response.ok || payload.errors?.length) {
    throw new Error(
      `Admin API request failed: ${JSON.stringify(payload.errors ?? payload)}`,
    );
  }

  return payload.data;
}

async function getSession() {
  const session = await prisma.session.findFirst({
    where: { shop: store, isOnline: false },
    orderBy: { id: "asc" },
  });
  if (!session) throw new Error(`No offline app session found for ${store}.`);

  const installation = await graphql(session.accessToken, APP_SCOPES_QUERY);
  const scopes = new Set(
    installation.currentAppInstallation.accessScopes.map(
      ({ handle }) => handle,
    ),
  );
  const missingScopes = [...REQUIRED_SCOPES].filter(
    (scope) => !scopes.has(scope),
  );
  if (missingScopes.length) {
    throw new Error(
      `Reauthorize the app before seeding. Missing scopes: ${missingScopes.join(", ")}`,
    );
  }

  return session;
}

async function upsert(accessToken, type, handle, values) {
  const data = await graphql(accessToken, UPSERT_MUTATION, {
    handle: { type, handle },
    values,
  });
  if (data.metaobjectUpsert.userErrors.length) {
    throw new Error(
      `Could not upsert ${type}/${handle}: ${JSON.stringify(data.metaobjectUpsert.userErrors)}`,
    );
  }
  return data.metaobjectUpsert.metaobject;
}

async function verifyType(accessToken, type, expectedHandles) {
  const nodes = await getTypeNodes(accessToken, type);
  const actual = new Set(nodes.map(({ handle }) => handle));
  const missing = expectedHandles.filter((handle) => !actual.has(handle));
  if (missing.length)
    throw new Error(`Missing ${type} records: ${missing.join(", ")}`);
  return nodes.length;
}

async function getTypeNodes(accessToken, type) {
  const data = await graphql(accessToken, METAOBJECTS_QUERY, {
    type,
    first: 100,
  });
  return data.metaobjects.nodes;
}

async function verifyDefinitions(accessToken) {
  const data = await graphql(accessToken, DEFINITIONS_QUERY, { first: 100 });

  for (const [type, expected] of EXPECTED_DEFINITIONS) {
    const definition = data.metaobjectDefinitions.nodes.find(
      ({ type: actualType }) => actualType.endsWith(`--${type}`),
    );
    if (!definition) throw new Error(`Missing metaobject definition: ${type}`);
    if (definition.name !== expected.name) {
      throw new Error(`${type} has unexpected name: ${definition.name}`);
    }
    const actualKeys = new Set(
      definition.fieldDefinitions.map(({ key }) => key),
    );
    const missingKeys = expected.keys.filter((key) => !actualKeys.has(key));
    if (missingKeys.length) {
      throw new Error(`${type} is missing fields: ${missingKeys.join(", ")}`);
    }
  }

  return EXPECTED_DEFINITIONS.size;
}

async function main() {
  const session = await getSession();
  const productData = await graphql(session.accessToken, PRODUCT_QUERY, {
    first: 100,
  });
  const productsByHandle = new Map(
    productData.products.nodes.map((product) => [product.handle, product.id]),
  );
  const missingProducts = fixture.profiles
    .map(({ productHandle }) => productHandle)
    .filter((handle) => !productsByHandle.has(handle));
  if (missingProducts.length) {
    throw new Error(
      `Catalog products are missing: ${missingProducts.join(", ")}`,
    );
  }

  const definitions = await verifyDefinitions(session.accessToken);
  if (!apply) {
    const [profiles, relations, policies] = await Promise.all([
      getTypeNodes(session.accessToken, "$app:merchandising_profile"),
      getTypeNodes(session.accessToken, "$app:offer_relation"),
      getTypeNodes(session.accessToken, "$app:ranking_policy"),
    ]);
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          store,
          preflight: {
            definitions,
            catalogProductsResolved: fixture.profiles.length,
            existing: {
              profiles: profiles.length,
              relations: relations.length,
              policies: policies.length,
            },
          },
          proposedUpserts: {
            profiles: fixture.profiles.length,
            relations: fixture.relations.length,
            policies: 1,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  const profileIds = new Map();
  for (const profile of fixture.profiles) {
    const record = await upsert(
      session.accessToken,
      "$app:merchandising_profile",
      profile.handle,
      {
        name: profile.name,
        product: productsByHandle.get(profile.productHandle),
        role: profile.role,
        audiences: profile.audiences,
        family: profile.family,
        ...(profile.substitutionGroup
          ? { substitution_group: profile.substitutionGroup }
          : {}),
        lifecycle: profile.lifecycle,
        ...(profile.claims.length ? { claims: profile.claims } : {}),
        exclusions: profile.exclusions,
        merchant_priority: profile.merchantPriority,
        eligible: profile.eligible,
      },
    );
    profileIds.set(profile.handle, record.id);
  }

  await upsert(
    session.accessToken,
    "$app:ranking_policy",
    fixture.policy.handle,
    {
      name: fixture.policy.name,
      version: fixture.policy.version,
      recently_viewed_weight: fixture.policy.recentlyViewedWeight,
    },
  );

  for (const relation of fixture.relations) {
    await upsert(session.accessToken, "$app:offer_relation", relation.handle, {
      name: relation.name,
      source_profile: profileIds.get(relation.source),
      ...(relation.target
        ? { target_profile: profileIds.get(relation.target) }
        : { action_key: relation.actionKey }),
      relationship: relation.relationship,
      base_weight: relation.baseWeight,
      rationale: relation.rationale,
      active: relation.active,
      max_discount: relation.maxDiscount,
      required_signals: relation.requiredSignals,
    });
  }

  const result = {
    mode: "applied",
    store,
    definitions,
    profiles: await verifyType(
      session.accessToken,
      "$app:merchandising_profile",
      fixture.profiles.map(({ handle }) => handle),
    ),
    relations: await verifyType(
      session.accessToken,
      "$app:offer_relation",
      fixture.relations.map(({ handle }) => handle),
    ),
    policies: await verifyType(session.accessToken, "$app:ranking_policy", [
      fixture.policy.handle,
    ]),
  };
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
