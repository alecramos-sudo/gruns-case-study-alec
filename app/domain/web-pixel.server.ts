import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { pixelToken } from "./tokens.server";

const PIXEL_QUERY = `#graphql
  query AppWebPixel {
    webPixel { id settings }
  }
`;

const CREATE_PIXEL = `#graphql
  mutation CreateAppWebPixel($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel { id settings }
      userErrors { field message code }
    }
  }
`;

const UPDATE_PIXEL = `#graphql
  mutation UpdateAppWebPixel($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      webPixel { id settings }
      userErrors { field message code }
    }
  }
`;

async function graphql<T>(
  admin: AdminApiContext,
  query: string,
  variables?: object,
  allowResourceNotFound = false,
) {
  const response = await admin.graphql(query, { variables });
  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{
      message: string;
      extensions?: { code?: string };
    }>;
  };
  const expectedMissingResource =
    allowResourceNotFound &&
    payload.errors?.every(
      ({ extensions }) => extensions?.code === "RESOURCE_NOT_FOUND",
    );
  if ((payload.errors?.length && !expectedMissingResource) || !payload.data) {
    throw new Error(
      payload.errors?.map(({ message }) => message).join("; ") ||
        "Shopify returned no data.",
    );
  }
  return payload.data;
}

export async function webPixelStatus(admin: AdminApiContext) {
  const data = await graphql<{ webPixel: { id: string } | null }>(
    admin,
    PIXEL_QUERY,
    undefined,
    true,
  );
  return Boolean(data.webPixel);
}

export async function enableWebPixel({
  admin,
  shop,
  endpoint,
}: {
  admin: AdminApiContext;
  shop: string;
  endpoint: string;
}) {
  const current = await graphql<{
    webPixel: { id: string; settings: unknown } | null;
  }>(admin, PIXEL_QUERY, undefined, true);
  const webPixel = {
    settings: JSON.stringify({ endpoint, shop, token: pixelToken(shop) }),
  };
  const data = current.webPixel
    ? await graphql<{
        webPixelUpdate: {
          webPixel: { id: string } | null;
          userErrors: Array<{ message: string }>;
        };
      }>(admin, UPDATE_PIXEL, { id: current.webPixel.id, webPixel })
    : await graphql<{
        webPixelCreate: {
          webPixel: { id: string } | null;
          userErrors: Array<{ message: string }>;
        };
      }>(admin, CREATE_PIXEL, { webPixel });
  const result =
    "webPixelUpdate" in data ? data.webPixelUpdate : data.webPixelCreate;
  if (result.userErrors.length || !result.webPixel) {
    throw new Error(
      result.userErrors.map(({ message }) => message).join("; ") ||
        "Shopify did not enable the web pixel.",
    );
  }
  return result.webPixel;
}
