import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signToken(payload: Record<string, unknown>, secret: string) {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode(payload);
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

export function signedChangeset({
  referenceId,
  changes,
}: {
  referenceId: string;
  changes: unknown[];
}) {
  const secret = process.env.SHOPIFY_API_SECRET;
  const issuer = process.env.SHOPIFY_API_KEY;
  if (!secret || !issuer)
    throw new Error("Shopify app credentials are missing.");
  return signToken(
    {
      iss: issuer,
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 5 * 60,
      sub: referenceId,
      changes,
    },
    secret,
  );
}

export function pixelToken(shop: string) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("Shopify app credentials are missing.");
  return createHmac("sha256", secret)
    .update(`checkout-intent:${shop}`)
    .digest("base64url");
}

export function verifyPixelToken(shop: string, token: string) {
  const expected = Buffer.from(pixelToken(shop), "base64url");
  const provided = Buffer.from(token, "base64url");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}
