import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { loadMerchandisingEngine } from "../domain/merchandising.server";
import { loadOrderProductIds } from "../domain/order-links.server";
import { postPurchaseShop } from "../domain/post-purchase-auth.mjs";
import { signDecision } from "../domain/post-purchase.server";
import { authenticate, unauthenticated } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(new Response(null, { status: 204 }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.checkout(request);
  const body = (await request.json()) as {
    referenceId?: unknown;
    decisionId?: unknown;
    variantId?: unknown;
    shop?: unknown;
  };
  const referenceId = String(body.referenceId ?? "").slice(0, 255);
  const decisionId = String(body.decisionId ?? "").slice(0, 255);
  const variantId = Number(body.variantId);
  const shop = postPurchaseShop(body.shop, sessionToken.dest);
  if (
    !referenceId ||
    referenceId !== sessionToken.sub ||
    !decisionId ||
    !Number.isSafeInteger(variantId) ||
    variantId <= 0 ||
    !shop
  ) {
    return cors(Response.json({ error: "Invalid offer." }, { status: 400 }));
  }

  const { admin } = await unauthenticated.admin(shop);
  try {
    const [engine, purchasedProductIds] = await Promise.all([
      loadMerchandisingEngine(admin),
      loadOrderProductIds(admin, referenceId),
    ]);
    const token = await signDecision({
      shop,
      referenceId,
      decisionId,
      variantId,
      engine,
      purchasedProductIds,
    });
    return cors(Response.json({ token }));
  } catch {
    return cors(
      Response.json(
        { error: "The offer is no longer available." },
        { status: 409 },
      ),
    );
  }
};
