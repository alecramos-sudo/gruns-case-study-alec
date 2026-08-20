import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const ORDERS_BY_CHECKOUT_TOKEN = `#graphql
  query OrdersByCheckoutToken($query: String!) {
    orders(first: 25, query: $query) {
      nodes { id legacyResourceId name checkoutToken }
    }
  }
`;

const ORDER_PRODUCTS_BY_CHECKOUT_TOKEN = `#graphql
  query OrderProductsByCheckoutToken($query: String!) {
    orders(first: 5, query: $query) {
      nodes {
        checkoutToken
        lineItems(first: 100) {
          nodes { product { id } }
        }
      }
    }
  }
`;

export async function loadOrderProductIds(
  admin: AdminApiContext,
  checkoutToken: string,
) {
  const response = await admin.graphql(ORDER_PRODUCTS_BY_CHECKOUT_TOKEN, {
    variables: {
      query: `checkout_token:${JSON.stringify(checkoutToken)}`,
    },
  });
  const payload = (await response.json()) as {
    data?: {
      orders: {
        nodes: Array<{
          checkoutToken?: string | null;
          lineItems: {
            nodes: Array<{ product?: { id: string } | null }>;
          };
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length || !payload.data) {
    throw new Error("Shopify order contents could not be verified.");
  }
  const order = payload.data.orders.nodes.find(
    (candidate) => candidate.checkoutToken === checkoutToken,
  );
  if (!order) throw new Error("Shopify order contents could not be verified.");
  return [
    ...new Set(
      order.lineItems.nodes.flatMap((lineItem) =>
        lineItem.product?.id ? [lineItem.product.id] : [],
      ),
    ),
  ];
}

export async function loadOrderLinks(
  admin: AdminApiContext,
  checkoutTokens: string[],
) {
  const uniqueTokens = [...new Set(checkoutTokens.filter(Boolean))].slice(
    0,
    25,
  );
  if (!uniqueTokens.length) return {};
  const query = uniqueTokens
    .map((token) => `checkout_token:${JSON.stringify(token)}`)
    .join(" OR ");
  const response = await admin.graphql(ORDERS_BY_CHECKOUT_TOKEN, {
    variables: { query },
  });
  const payload = (await response.json()) as {
    data?: {
      orders: {
        nodes: Array<{
          id: string;
          legacyResourceId: string;
          name: string;
          checkoutToken?: string | null;
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length || !payload.data) {
    throw new Error("Shopify orders could not be resolved.");
  }
  return Object.fromEntries(
    payload.data.orders.nodes
      .filter((order) => order.checkoutToken)
      .map((order) => [
        order.checkoutToken,
        {
          legacyResourceId: order.legacyResourceId,
          name: order.name,
        },
      ]),
  );
}
