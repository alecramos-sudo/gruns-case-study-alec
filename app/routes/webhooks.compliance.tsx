import type { ActionFunctionArgs } from "react-router";

import { captureCustomerDataRequest } from "../domain/privacy.server";
import { deleteShopData, redactCustomerData } from "../domain/retention.server";
import { normalizeShopifyId } from "../domain/shopify-id.mjs";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  const normalizedTopic = String(topic).toUpperCase().replaceAll("/", "_");

  if (normalizedTopic === "SHOP_REDACT") {
    await deleteShopData(shop);
  }

  if (normalizedTopic === "CUSTOMERS_REDACT") {
    const customerId = normalizeShopifyId(
      (payload as { customer?: { id?: unknown } }).customer?.id,
    );
    if (!customerId) {
      throw new Response("Missing customer ID", { status: 400 });
    }
    await redactCustomerData(shop, customerId);
  }

  if (normalizedTopic === "CUSTOMERS_DATA_REQUEST") {
    const requestPayload = payload as {
      customer?: { id?: unknown };
      data_request?: { id?: unknown };
    };
    const customerId = normalizeShopifyId(requestPayload.customer?.id);
    const requestId = String(requestPayload.data_request?.id ?? "");
    if (!customerId || !requestId) {
      throw new Response("Invalid customer data request", { status: 400 });
    }
    await captureCustomerDataRequest({ shop, customerId, requestId });
  }

  return new Response(null, { status: 204 });
};
