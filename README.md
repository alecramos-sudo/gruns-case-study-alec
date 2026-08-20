# Grüns intent-aware post-purchase offer

A Shopify case study that turns merchant-approved product pairings and recent storefront intent into one post-purchase offer. The original assignment is included in [Case_Study_Senior_Full_Stack_Shopify_Developer.pdf](./Case_Study_Senior_Full_Stack_Shopify_Developer.pdf).

## What it demonstrates

- A Shopify-hosted post-purchase extension that authenticates Shopify's checkout token, calculates a one-click add-on, asks for optional structured feedback, and records impressions, accepts, declines, and estimated offer revenue.
- A deterministic ranker with hard exclusions, a merchant-controlled pairing priority from 1-30, a bounded +40 exact-view boost, and a 75% boost for approved products with a similar merchandising role.
- A consent-aware Web Pixel that stores up to five `product_viewed` product IDs in Shopify’s sandboxed browser storage and sends them with `checkout_started`.
- App-owned Shopify metaobjects as the source of truth for product profiles, approved pairings, discounts, and ranking policy.
- One optional OpenAI-compatible model call that returns up to three merchant-review recommendations. Checkout never waits on the model.
- A Polaris Web Components App Home with a decision simulator, native Product Resource Picker, pairing controls, AI context/spend, ShopifyQL sales context, App Events, analytics annotations, per-offer performance, and buyer feedback.

## Architecture

```text
Web Pixel product_viewed
  -> Shopify sandboxed localStorage (five product IDs)
  -> Web Pixel checkout_started
  -> CheckoutIntent keyed by exact checkout token (24-hour retention)

Completed checkout
  -> ShouldRender API
  -> signed checkout token binds the purchase reference
  -> all purchased products excluded
  -> pairing priority (1-30) + exact/similar recent-view boost
  -> OfferDecision
  -> Shopify-calculated one-click offer
  -> signed changeset
  -> accepted / declined / optional feedback

Merchant App Home
  -> Shopify metaobjects
  -> ShopifyQL sales context
  -> Shopify analytics annotation on pairing changes
  -> custom App Events in Dev Dashboard
  -> optional OpenAI-compatible recommendation drafts
  -> explicit merchant approval
```

The key decision is to separate configuration-time intelligence from checkout-time execution. The model can improve a merchant’s starting point, but only approved Shopify custom data reaches buyers. Runtime ranking remains fast, inspectable, and available when the provider or recent-view signal is absent.

Open the [interactive system map](./docs/system-map.html) for the buyer flow, merchant flow, Shopify data boundaries, and AI boundary.

## Local setup

Requirements: Node.js 22.18+, Shopify CLI 4.6+, a Shopify Partner development store, and Bogus Gateway for test orders.

```sh
npm install
npm run setup
cp .env.example .env
shopify app dev --store your-store.myshopify.com
```

Shopify CLI supplies the app URL, API key, API secret, scopes, and session storage environment. The AI provider is optional:

```sh
# Direct OpenAI, using the default gpt-5.6-luna model
OPENAI_API_KEY=...

# Or any OpenAI-compatible Responses API, including OpenRouter
AI_API_KEY=...
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=openai/gpt-5.6-luna
```

Provider credentials are server-only. They are never stored in Shopify custom data, returned to App Home, or sent to the browser. Without a provider key, App Home creates the same reviewable recommendation shape with a deterministic local fallback.

For a new store:

1. Install the development app from the CLI preview link.
2. Seed or create products, then run `npm run merchandising:seed -- --apply` after updating the fixture and store guard for that store.
3. Open App Home and select **Enable pixel** to create or refresh the app Web Pixel.
4. Shopify CLI supplies `APP_URL` to the post-purchase extension from the active app configuration.
5. Use Shopify CLI's post-purchase development preview. A production merchant must select the app in checkout settings and the app needs Shopify post-purchase access.
6. Reauthorize after requesting `read_orders`, `read_reports`, and analytics-annotation scopes. ShopifyQL also requires Level 2 protected customer data access.

The Grüns catalog seeder is intentionally locked to `gruns-case-study.myshopify.com`. Its default run is a dry run. Store mutation requires `--apply`.

## Test the full flow

The App Home decision simulator exercises the production ranker without creating an order. Use it to compare the baseline pairing with a simulated recent view and inspect every score.

The hosted extension still requires Shopify’s post-purchase preview or a supported checkout:

1. Visit a complementary product on the storefront with the required consent granted.
2. Add a different product to cart and complete checkout with Bogus Gateway.
3. Confirm the post-purchase page says the original order is confirmed and shows one eligible product with a Shopify-calculated total. If the product has multiple available variants, change the option and confirm the price breakdown recalculates.
4. Optionally choose a feedback reason, then accept or decline the offer.
5. Return to App Home and verify the signal join, outcome, feedback, conversion rate, and estimated offer revenue.

There is no shop-wide time-window fallback. If Shopify’s post-purchase reference cannot match the checkout token, the recent-view boost is omitted and the approved merchant pairing remains the deterministic fallback.

Run local checks with:

```sh
npm test
npm run typecheck
npm run lint
npm run build
shopify app config validate
```

## Analytics truth

- Local `OfferDecision` rows power offer-specific impressions, outcomes, buyer feedback, conversion, and estimated offer revenue. The estimate uses the accepted variant's catalog price and approved discount; production attribution should reconcile against the updated Shopify order.
- ShopifyQL supplies Shopify’s sales and order context for the last 30 days through Admin GraphQL. Shopify excludes development-store test orders from sales reports, so Bogus Gateway checkouts can produce real app outcomes while ShopifyQL correctly remains at zero.
- Pairing publishes and edits attempt an app-authored Shopify Analytics annotation through Shopify's unstable Admin surface and degrade to a visible warning when unavailable.
- Privacy-safe custom App Events are sent for impressions, accepts, declines, and AI recommendation generation. They appear in Shopify Dev Dashboard logs.
- Custom App Events are not claimed as merchant-queryable Shopify Analytics data. `FROM app_events` requires Shopify early access and an accepted standard-event declaration.

## Safety, privacy, and cost controls

- Public checkout routes verify Shopify's post-purchase token and bind every request to its signed purchase reference. The legacy token does not include a shop claim, so the extension supplies its normalized Shopify domain and initial line items for fast ranking. Before authorizing an add-on, the signing route verifies the purchased source product against Shopify's order and revalidates the selected variant.
- The Web Pixel endpoint requires a per-shop HMAC token and accepts only five short product identifiers.
- The pixel declares analytics and preferences purposes. Missing consent or browser storage means no recent-view boost, never a blocked checkout.
- Checkout intents expire after 24 hours and are capped at 500 rows per shop. App uninstall and `shop/redact` delete sessions, checkout intents, offer decisions, and AI usage for the shop.
- The app does not request Shopify customer name, email, or address fields. It keeps the Shopify customer ID only when checkout supplies one so `customers/redact` can remove linked feedback, then clears the ID during redaction. The ID is not used for ranking. Optional Other feedback can contain buyer-supplied text, so it is bounded, redacted for obvious contact details, and deleted after 30 days. "Already purchased" means present in the current checkout; historical purchase exclusion is outside v1. Checkout/reference identifiers are treated as pseudonymous protected data and masked in App Home.
- Buyer feedback is optional. Fixed choices are preferred. Other text is capped at 120 characters, redacts obvious email/phone/URL content, expires after 30 days, and is never sent raw to an AI provider.
- The provider receives one source, at most six eligible candidates, existing pairing context, and at most 100 aggregate outcomes. It returns at most three drafts, has an 800-token output cap, a 10-second timeout, and no retries. Daily limits default to 20 calls per shop and 100 across the app; `AI_DAILY_SHOP_LIMIT` and `AI_DAILY_GLOBAL_LIMIT` can lower or raise them within server-enforced bounds.
- Provider input, cached input, and output tokens are recorded. GPT-5.6 Luna spend uses the documented request-time rate; configurable providers can return their own cost. Estimates are labeled as estimates.
- Every model draft requires explicit merchant approval. Model output cannot change checkout ranking automatically.
- Mandatory `customers/data_request`, `customers/redact`, and `shop/redact` compliance webhooks are configured and verified through Shopify’s webhook authenticator.
- Customer data requests create a 30-day JSON export in App Home. Customer redaction anonymizes linked outcomes and deletes any pending export.

## Roadmap talking points

- Add a Shopify Sidekick app extension so merchants can inspect and manage merchandising profiles, offer paths, discounts, and ranking policy through Sidekick tools while keeping the same approval and audit boundaries as App Home.
- Use accepted and declined offer outcomes to recommend policy changes, but keep automatic publishing out of the checkout path until controlled experiments prove the change.

## Production evolution

Before broad distribution, move SQLite to a managed database, rate-limit the public pixel-ingestion route at the edge, rotate pixel credentials per installation, add provider-spend alerts, cache versioned merchandising data, add webhook-driven invalidation and background retention jobs, reconcile accepted offers from Shopify orders, verify the post-purchase reference/checkout-token join across supported payment paths, deploy the backend before publishing the extension, complete Shopify’s Level 2 and post-purchase access reviews, add operational alerting, and run controlled holdout experiments before changing ranking priorities. Historical purchase exclusion, multi-offer sequencing, automatic learning, and incrementality reporting remain explicit product work rather than implied demo features.

## AI-assisted development

AI was used for research, implementation, review, test generation, and concept imagery. The public [AI-assisted development record](./.ai/AI_PROCESS.md) summarizes the stages, decisions, reviews, cuts, model use, and verification without publishing raw prompts or private preparation notes. Nothing is committed without human review and approval.
