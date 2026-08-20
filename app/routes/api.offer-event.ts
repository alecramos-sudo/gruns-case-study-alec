import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { loadMerchandisingEngine } from "../domain/merchandising.server";
import { recordOutcome } from "../domain/post-purchase.server";
import { normalizeBuyerFeedback } from "../domain/buyer-feedback.mjs";
import { emitAppEvent } from "../domain/app-events.server";
import { postPurchaseShop } from "../domain/post-purchase-auth.mjs";
import { pruneRawFeedback } from "../domain/retention.server";
import { authenticate, unauthenticated } from "../shopify.server";

const EVENTS = new Set(["impression", "accepted", "declined"]);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(new Response(null, { status: 204 }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.checkout(request);
  const body = (await request.json()) as {
    referenceId?: unknown;
    decisionId?: unknown;
    event?: unknown;
    shop?: unknown;
    feedbackChoice?: unknown;
    feedbackText?: unknown;
  };
  const referenceId = String(body.referenceId ?? "").slice(0, 255);
  const decisionId = String(body.decisionId ?? "").slice(0, 255);
  const event = String(body.event ?? "");
  const shop = postPurchaseShop(body.shop, sessionToken.dest);
  let feedback: { choice: string | null; text: string | null };
  try {
    feedback = normalizeBuyerFeedback(body.feedbackChoice, body.feedbackText);
  } catch {
    return cors(Response.json({ error: "Invalid feedback." }, { status: 400 }));
  }
  if (
    !referenceId ||
    referenceId !== sessionToken.sub ||
    !decisionId ||
    !shop ||
    !EVENTS.has(event)
  ) {
    return cors(Response.json({ error: "Invalid event." }, { status: 400 }));
  }
  const adminContext = await unauthenticated.admin(shop);
  const engine =
    event === "accepted"
      ? await loadMerchandisingEngine(adminContext.admin)
      : undefined;
  const decision = await recordOutcome({
    shop,
    referenceId,
    decisionId,
    event: event as "impression" | "accepted" | "declined",
    engine,
    feedback: event === "impression" ? undefined : feedback,
  });
  await pruneRawFeedback(shop);
  const eventMatchesOutcome =
    event === "impression" || decision.status === event;
  if (eventMatchesOutcome) {
    await emitAppEvent({
      admin: adminContext.admin,
      eventHandle: `post_purchase_offer_${event}`,
      key: `${decision.id}:${event}`,
      attributes: {
        source_handle: decision.sourceHandle,
        offer_handle: decision.offerHandle,
        score: decision.score,
        used_recent_view: decision.usedRecentView,
        ...(feedback.choice ? { feedback_choice: feedback.choice } : {}),
      },
    }).catch(() => undefined);
  }
  return cors(Response.json({ ok: true }));
};
