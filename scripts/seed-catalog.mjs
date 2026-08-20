import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const API_VERSION = "2026-07";
const DEFAULT_STORE = "gruns-case-study.myshopify.com";
const CREATE_ONLY_HANDLES = [
  "gruns-run-club-bandana",
  "little-gruns-adventure-stickers",
];
const AGENT_SESSION = "ceb359a4-7395-4487-be43-f16b1e81121e";
const AGENT_RUN = "gruns-catalog-20260819";

const CATALOG_QUERY = `
  query CatalogState {
    products(first: 100) {
      nodes {
        id
        handle
        title
        status
        tags
        variants(first: 100) {
          nodes {
            id
            sku
            title
            price
            inventoryQuantity
            selectedOptions { name value }
          }
        }
      }
    }
  }
`;

const LOCATION_QUERY = `
  query ActiveLocations {
    locations(first: 10, includeInactive: false) {
      nodes { id name }
    }
  }
`;

const STAGED_UPLOAD_MUTATION = `
  mutation CreateStagedUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

const PRODUCT_SET_MUTATION = `
  mutation UpsertProduct($identifier: ProductSetIdentifiers!, $input: ProductSetInput!) {
    productSet(identifier: $identifier, input: $input, synchronous: true) {
      product { id handle title status }
      userErrors { code field message }
    }
  }
`;

const ARCHIVE_MUTATION = `
  mutation ArchiveProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id handle status }
      userErrors { field message }
    }
  }
`;

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const store = readArg("--store", DEFAULT_STORE);
const apply = process.argv.includes("--apply");
const onlyNew = process.argv.includes("--only-new");

if (apply && store !== DEFAULT_STORE) {
  throw new Error(
    `Refusing to mutate ${store}. This seed is locked to ${DEFAULT_STORE}.`,
  );
}

const fixturePath = resolve("data/catalog.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function execute(query, variables = {}, allowMutations = false) {
  const args = [
    "store",
    "execute",
    "--store",
    store,
    "--version",
    API_VERSION,
    "--json",
    "--query",
    query,
    "--variables",
    JSON.stringify(variables),
  ];

  if (allowMutations) args.push("--allow-mutations");

  const result = spawnSync("shopify", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      SHOPIFY_CLI_AGENT_INFO: "n:codex|v:none|p:openai|m:gpt-5.6-sol",
      SHOPIFY_CLI_AGENT_IDS: `s:${AGENT_SESSION}|r:${AGENT_RUN}`,
    },
  });

  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `Shopify CLI exited ${result.status}`,
    );
  }

  const firstBrace = result.stdout.indexOf("{");
  if (firstBrace === -1)
    throw new Error(`Shopify CLI returned no JSON:\n${result.stdout}`);

  const payload = JSON.parse(result.stdout.slice(firstBrace));
  if (payload.errors?.length)
    throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload;
}

function assertNoUserErrors(operation, label) {
  if (operation.userErrors?.length) {
    throw new Error(
      `${label} failed:\n${JSON.stringify(operation.userErrors, null, 2)}`,
    );
  }
  return operation;
}

function getState() {
  const result = execute(CATALOG_QUERY);
  return new Map(
    result.products.nodes.map((product) => [product.handle, product]),
  );
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function variantKey(optionValues) {
  return optionValues.join(" / ");
}

function seedFingerprint(product) {
  const digest = createHash("sha256")
    .update(JSON.stringify(product))
    .digest("hex")
    .slice(0, 12);
  return `case-study-seed:${digest}`;
}

function desiredTags(product) {
  return [...product.tags, seedFingerprint(product)];
}

function isUnchanged(expected, actual) {
  if (actual.title !== expected.title || actual.status !== "ACTIVE")
    return false;
  if (!sameStrings(actual.tags, desiredTags(expected))) return false;
  if (actual.variants.nodes.length !== expected.variants.length) return false;

  const actualVariants = new Map(
    actual.variants.nodes.map((variant) => [
      variantKey(variant.selectedOptions.map((option) => option.value)),
      variant,
    ]),
  );

  return expected.variants.every((variant) => {
    const current = actualVariants.get(variantKey(variant.optionValues));
    return (
      current &&
      current.sku === variant.sku &&
      current.price === variant.price &&
      current.inventoryQuantity === variant.inventoryQuantity
    );
  });
}

function planFrom(state) {
  const upserts = fixture.products.map((product) => {
    const current = state.get(product.handle);
    return {
      handle: product.handle,
      action: !current
        ? "create"
        : isUnchanged(product, current)
          ? "unchanged"
          : "update",
      sourceType: product.sourceType,
      variants: product.variants.length,
    };
  });

  const archive = fixture.archiveHandles
    .map((handle) => state.get(handle))
    .filter((product) => product && product.status !== "ARCHIVED")
    .map((product) => ({
      handle: product.handle,
      id: product.id,
      action: "archive",
    }));

  return { store, apply, onlyNew, upserts, archive };
}

async function stageLocalImage(imagePath) {
  const absolutePath = resolve(imagePath);
  const bytes = await readFile(absolutePath);
  const filename = basename(imagePath);
  const staged = execute(
    STAGED_UPLOAD_MUTATION,
    {
      input: [
        {
          filename,
          mimeType: "image/png",
          resource: "PRODUCT_IMAGE",
          httpMethod: "POST",
        },
      ],
    },
    true,
  ).stagedUploadsCreate;

  assertNoUserErrors(staged, `Create staged upload for ${filename}`);
  const target = staged.stagedTargets[0];
  if (!target?.url || !target.resourceUrl)
    throw new Error(`Missing staged upload target for ${filename}`);

  const form = new FormData();
  for (const parameter of target.parameters)
    form.append(parameter.name, parameter.value);
  form.append("file", new Blob([bytes], { type: "image/png" }), filename);

  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) {
    throw new Error(
      `Upload failed for ${filename}: ${upload.status} ${await upload.text()}`,
    );
  }

  return target.resourceUrl;
}

function productInput(product, locationId, imageSource) {
  const imageExtension = product.image?.path
    ? extname(product.image.path)
    : product.image?.source
      ? extname(new URL(product.image.source).pathname)
      : "";

  return {
    title: product.title,
    handle: product.handle,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    status: "ACTIVE",
    tags: desiredTags(product),
    productOptions: product.options.map((option) => ({
      name: option.name,
      values: option.values.map((name) => ({ name })),
    })),
    variants: product.variants.map((variant) => ({
      optionValues: variant.optionValues.map((name, index) => ({
        optionName: product.options[index].name,
        name,
      })),
      price: variant.price,
      ...(variant.compareAtPrice
        ? { compareAtPrice: variant.compareAtPrice }
        : {}),
      inventoryPolicy: "DENY",
      inventoryItem: {
        sku: variant.sku,
        tracked: true,
        requiresShipping: true,
      },
      inventoryQuantities: [
        {
          locationId,
          name: "available",
          quantity: variant.inventoryQuantity,
        },
      ],
    })),
    ...(imageSource
      ? {
          files: [
            {
              originalSource: imageSource,
              alt: product.image.alt,
              contentType: "IMAGE",
              filename: `${product.handle}-featured${imageExtension}`,
              duplicateResolutionMode: "REPLACE",
            },
          ],
        }
      : {}),
  };
}

function assertTargets(state, handles) {
  const failures = [];
  const targets = handles
    ? fixture.products.filter((product) => handles.includes(product.handle))
    : fixture.products;
  for (const target of targets) {
    const actual = state.get(target.handle);
    if (!actual) failures.push(`${target.handle}: missing`);
    else if (actual.status !== "ACTIVE")
      failures.push(`${target.handle}: status ${actual.status}`);
    else if (actual.variants.nodes.length !== target.variants.length) {
      failures.push(
        `${target.handle}: ${actual.variants.nodes.length} variants, expected ${target.variants.length}`,
      );
    }
  }
  if (failures.length)
    throw new Error(`Target verification failed:\n${failures.join("\n")}`);
}

const before = getState();
const plan = planFrom(before);
console.log(JSON.stringify(plan, null, 2));

if (!apply) {
  console.log(
    `\nDry run only. Re-run with --apply to mutate ${DEFAULT_STORE}.`,
  );
  process.exit(0);
}

if (
  plan.upserts.length !== 20 ||
  plan.archive.length > fixture.archiveHandles.length
) {
  throw new Error(
    `Safety check failed: expected 20 target products and at most ${fixture.archiveHandles.length} archive candidates, found ${plan.upserts.length} and ${plan.archive.length}.`,
  );
}

if (apply && onlyNew) {
  const creates = plan.upserts
    .filter(({ action }) => action === "create")
    .map(({ handle }) => handle)
    .sort();
  const unexpectedCreates = creates.filter(
    (handle) => !CREATE_ONLY_HANDLES.includes(handle),
  );
  if (unexpectedCreates.length) {
    throw new Error(
      `Create-only safety check failed: unexpected targets ${unexpectedCreates.join(", ")}.`,
    );
  }
}

const locations = execute(LOCATION_QUERY).locations.nodes;
if (locations.length === 0)
  throw new Error("No active Shopify location found for inventory.");
const location = locations[0];
const mutations = [];
const plannedByHandle = new Map(
  plan.upserts.map((item) => [item.handle, item]),
);

for (const product of fixture.products) {
  if (onlyNew && plannedByHandle.get(product.handle).action !== "create") {
    console.log(`Preserved ${product.handle}`);
    continue;
  }
  if (plannedByHandle.get(product.handle).action === "unchanged") {
    console.log(`Unchanged ${product.handle}`);
    continue;
  }

  const imageSource = product.image
    ? product.image.source || (await stageLocalImage(product.image.path))
    : undefined;
  const result = execute(
    PRODUCT_SET_MUTATION,
    {
      identifier: { handle: product.handle },
      input: productInput(product, location.id, imageSource),
    },
    true,
  ).productSet;

  assertNoUserErrors(result, `Upsert ${product.handle}`);
  mutations.push({
    action: "upsert",
    handle: result.product.handle,
    id: result.product.id,
    status: result.product.status,
  });
  console.log(`Upserted ${result.product.handle}`);
}

const afterUpserts = getState();
assertTargets(afterUpserts, onlyNew ? CREATE_ONLY_HANDLES : undefined);

if (!onlyNew) {
  for (const candidate of plan.archive) {
    const result = execute(
      ARCHIVE_MUTATION,
      { product: { id: candidate.id, status: "ARCHIVED" } },
      true,
    ).productUpdate;
    assertNoUserErrors(result, `Archive ${candidate.handle}`);
    mutations.push({
      action: "archive",
      handle: result.product.handle,
      id: result.product.id,
      status: result.product.status,
    });
    console.log(`Archived ${result.product.handle}`);
  }
}

const finalState = getState();
assertTargets(finalState, onlyNew ? CREATE_ONLY_HANDLES : undefined);
if (!onlyNew) {
  for (const handle of fixture.archiveHandles) {
    const product = finalState.get(handle);
    if (product && product.status !== "ARCHIVED") {
      throw new Error(`${handle} was not archived.`);
    }
  }
}

console.log("\nMutation report");
console.log(JSON.stringify({ store, location, mutations }, null, 2));
