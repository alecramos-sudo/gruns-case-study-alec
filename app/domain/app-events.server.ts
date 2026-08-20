import { createHash } from "node:crypto";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

let cachedToken: { value: string; expiresAt: number } | null = null;

export function appEventsConfigured() {
  return Boolean(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET);
}

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("App Events credentials are missing.");
  const response = await fetch("https://api.shopify.com/auth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(2_000),
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!response.ok) throw new Error("App Events authentication failed.");
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token)
    throw new Error("App Events returned no access token.");
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000,
  };
  return cachedToken.value;
}

async function shopId(admin: AdminApiContext) {
  const response = await admin.graphql(`#graphql { shop { id } }`);
  const body = (await response.json()) as {
    data?: { shop?: { id?: string } };
  };
  if (!body.data?.shop?.id) throw new Error("Shopify returned no shop ID.");
  return body.data.shop.id;
}

function idempotencyKey(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 64);
}

export async function emitAppEvent({
  admin,
  eventHandle,
  key,
  attributes,
}: {
  admin: AdminApiContext;
  eventHandle: string;
  key: string;
  attributes: Record<string, string | number | boolean>;
}) {
  const [token, id] = await Promise.all([accessToken(), shopId(admin)]);
  const response = await fetch("https://api.shopify.com/app/unstable/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(2_000),
    body: JSON.stringify({
      shop_id: id,
      event_handle: eventHandle.slice(0, 64),
      timestamp: new Date().toISOString(),
      idempotency_key: idempotencyKey(key),
      attributes,
    }),
  });
  if (response.status !== 202) {
    throw new Error(`App Events returned ${response.status}.`);
  }
}
