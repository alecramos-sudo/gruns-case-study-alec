import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { verifyPixelToken } from "../domain/tokens.server";
import { pruneCheckoutIntents } from "../domain/retention.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return new Response(null, {
    status: request.method === "OPTIONS" ? 204 : 405,
    headers: CORS_HEADERS,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 8_192) {
    return Response.json(
      { error: "Payload too large." },
      { status: 413, headers: CORS_HEADERS },
    );
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 8_192) {
    return Response.json(
      { error: "Payload too large." },
      { status: 413, headers: CORS_HEADERS },
    );
  }
  const body = (() => {
    try {
      return JSON.parse(rawBody);
    } catch {
      return null;
    }
  })() as {
    token?: unknown;
    shop?: unknown;
    checkoutToken?: unknown;
    recentlyViewed?: unknown;
  } | null;
  if (!body) {
    return Response.json(
      { error: "Invalid JSON." },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const shop = String(body.shop ?? "").slice(0, 255);
  if (!shop || !verifyPixelToken(shop, String(body.token ?? ""))) {
    return Response.json(
      { error: "Unauthorized." },
      { status: 401, headers: CORS_HEADERS },
    );
  }
  const checkoutToken = String(body.checkoutToken ?? "").slice(0, 255);
  const recentlyViewed = Array.isArray(body.recentlyViewed)
    ? body.recentlyViewed
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.slice(0, 120))
        .slice(0, 5)
    : [];
  if (!checkoutToken) {
    return Response.json(
      { error: "Missing checkout token." },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  await prisma.checkoutIntent.upsert({
    where: {
      shop_checkoutToken: { shop, checkoutToken },
    },
    create: {
      shop,
      checkoutToken,
      recentlyViewed: JSON.stringify(recentlyViewed),
    },
    update: { recentlyViewed: JSON.stringify(recentlyViewed) },
  });
  await pruneCheckoutIntents(shop);
  return Response.json({ ok: true }, { headers: CORS_HEADERS });
};
