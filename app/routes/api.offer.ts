import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { loadMerchandisingEngine } from "../domain/merchandising.server";
import { postPurchaseShop } from "../domain/post-purchase-auth.mjs";
import { prepareOffer } from "../domain/post-purchase.server";
import { authenticate, unauthenticated } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(new Response(null, { status: 204 }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.checkout(request);
  const body = (await request.json()) as {
    referenceId?: unknown;
    productIds?: unknown;
    shop?: unknown;
  };
  const referenceId = String(body.referenceId ?? "").slice(0, 255);
  const shop = postPurchaseShop(body.shop, sessionToken.dest);
  const productIds = Array.isArray(body.productIds)
    ? body.productIds
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0)
        .slice(0, 25)
    : [];
  if (
    !referenceId ||
    referenceId !== sessionToken.sub ||
    !shop ||
    !productIds.length
  ) {
    return cors(Response.json({ offers: [] }, { status: 400 }));
  }

  const { admin } = await unauthenticated.admin(shop);
  const engine = await loadMerchandisingEngine(admin);
  const offer = await prepareOffer({
    shop,
    referenceId,
    productIds,
    engine,
  });
  return cors(Response.json({ offers: offer ? [offer] : [] }));
};
