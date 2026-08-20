# AI-assisted development record

This case study was built with AI-assisted research, implementation, and review. This record summarizes the work without publishing raw prompts, credentials, private preparation notes, or hidden reasoning.

## Ownership

Alec owned the product direction, scope, architecture choices, acceptance criteria, merchant experience, testing decisions, and final approval. Codex was the primary implementation partner. Claude was used for independent adversarial review. GPT Image generated the clearly labeled concept-product images.

The code was not accepted because a model produced it. Each retained feature had to match the assignment, use a defensible Shopify contract, pass local checks, and work in the development store.

## Work stages

### 1. Establish the Shopify baseline

- Started from Shopify's official React Router app and post-purchase extension patterns.
- Kept the buyer charge flow on Shopify's native `calculateChangeset` and signed `applyChangeset` lifecycle.
- Verified the placeholder extension with a Bogus Gateway checkout before adding product logic.

### 2. Model the catalog and merchant policy

- Studied Grüns' public catalog and mirrored a representative development-store catalog.
- Added clearly disclosed concept accessories to demonstrate complementary offers.
- Modeled product profiles, approved offer relations, discounts, exclusions, and ranking policy as app-owned Shopify metaobjects.
- Built repeatable dry-run-first seed scripts and guarded store mutations.

### 3. Build deterministic runtime ranking

- Added hard exclusions for products already in the checkout, unavailable products, product-family conflicts, substitutes, paused paths, and held signal-dependent paths.
- Ranked only merchant-approved relations.
- Added a bounded recent-view boost after exclusions, including a smaller boost for an approved product with the same merchandising role.
- Kept all model calls outside checkout so buyer rendering remains deterministic and inspectable.

### 4. Add storefront intent

- Added a consent-aware Web Pixel for Shopify's standard `product_viewed` and `checkout_started` events.
- Stored a small recent-view list in Shopify's sandboxed browser storage.
- Joined the signal to checkout with Shopify's checkout token and short retention.
- Preserved a deterministic merchant-pairing fallback when no exact signal is available.

### 5. Build the merchant App Home

- Reworked the first dashboard into a focused Polaris Web Components workspace.
- Added native product selection, product-profile editing, relation controls, a score trace, exclusions, buyer preview, AI drafts, ShopifyQL context, and recent outcomes.
- Moved configuration changes behind explicit merchant review and publication.
- Clarified which metrics come from Shopify and which are app-owned test metrics.

### 6. Add bounded AI assistance

- Added one server-side OpenAI-compatible call for profile or pairing drafts.
- Limited candidates, context, output tokens, execution time, daily runs, and recommendations.
- Recorded provider-reported usage and cost when available.
- Kept raw buyer text out of provider context and required merchant approval for every draft.

### 7. Add analytics, privacy, and compliance

- Connected ShopifyQL for store-level sales context.
- Added best-effort Shopify Analytics annotations and privacy-safe App Events.
- Stored impression and outcome data in the app database for case-study measurement.
- Added Shopify compliance webhooks, customer export/redaction handling, uninstall cleanup, identifier masking, bounded feedback, and retention rules.

### 8. Review and harden

Independent reviews focused on Shopify token contracts, variant authorization, multi-shop isolation, metric definitions, privacy claims, AI cost controls, and production gaps. Material fixes included:

- Binding requests to the signed post-purchase reference, normalizing the extension's Shopify domain, and revalidating the purchased source product against the Shopify order before signing a changeset.
- Rejecting unavailable or foreign variants at signing time.
- Counting all shown offers in the conversion denominator.
- Making terminal outcomes immutable.
- Guarding an empty post-purchase storage state and continuing to order confirmation.
- Adding an expiration to partner-issued changeset tokens.

## Features deliberately removed or deferred

- Model calls in checkout.
- Automatic publishing or self-modifying ranking policy.
- Historical customer purchase segmentation.
- Multi-offer sequencing.
- Claims of causal revenue lift without holdouts.
- Production database, queues, cache invalidation, edge rate limiting, and operational alerting.

These were cut to keep the case study focused and honest. They remain production work, not implied capabilities.

## Verification

The project uses unit tests for ranking, profile normalization, AI bounds, feedback handling, variants, signed post-purchase context, Shopify ID normalization, conversion, and order-product verification. The implementation was also checked with TypeScript, ESLint, production builds, Shopify extension builds, Prisma validation, dependency auditing, secret scanning, and development-store checkouts.

## Model and cost disclosure

- Primary implementation: Codex, GPT-5.6 series.
- Independent review: Claude Fable and Claude Opus runs.
- Concept imagery: GPT Image.
- In-app merchant drafts: configurable OpenAI-compatible Responses API; the demo used GPT-5.6 Luna.
- Coding-harness token totals and billed cost were not consistently available, so this document does not invent estimates.
- The app records runtime draft requests, tokens, and provider-reported or model-priced cost.
