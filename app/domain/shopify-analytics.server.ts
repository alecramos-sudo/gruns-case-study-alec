import { ApiVersion } from "@shopify/shopify-app-react-router/server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const SALES_QUERY = "FROM sales SHOW total_sales, orders SINCE -30d";

export type ShopifySalesSummary =
  | {
      status: "ready";
      totalSales: number;
      orders: number;
      query: string;
    }
  | { status: "unavailable"; error: string; query: string };

export function shopifyAnalyticsErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/access denied|read_reports|protected customer data/i.test(raw)) {
    return "ShopifyQL needs read_reports and Level 2 protected customer data. Reauthorize after access is approved.";
  }
  return "Shopify Analytics could not load. Try again.";
}

export async function loadShopifySalesSummary(
  admin: AdminApiContext,
): Promise<ShopifySalesSummary> {
  try {
    const response = await admin.graphql(
      `#graphql
        query ShopifySalesSummary($query: String!) {
          shopifyqlQuery(query: $query) {
            tableData {
              columns { name dataType displayName }
              rows
            }
            parseErrors
          }
        }
      `,
      { variables: { query: SALES_QUERY } },
    );
    const payload = (await response.json()) as {
      data?: {
        shopifyqlQuery?: {
          tableData?: { rows?: Array<Record<string, unknown>> };
          parseErrors?: string[];
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (payload.errors?.length) {
      throw new Error(payload.errors.map(({ message }) => message).join("; "));
    }
    const result = payload.data?.shopifyqlQuery;
    if (result?.parseErrors?.length) {
      throw new Error(result.parseErrors.join("; "));
    }
    const row = result?.tableData?.rows?.[0] ?? {};
    return {
      status: "ready",
      totalSales: Number(row.total_sales ?? 0),
      orders: Number(row.orders ?? 0),
      query: SALES_QUERY,
    };
  } catch (error) {
    return {
      status: "unavailable",
      error: shopifyAnalyticsErrorMessage(error),
      query: SALES_QUERY,
    };
  }
}

export async function createPairingAnnotation(
  admin: AdminApiContext,
  input: { title: string; description: string },
) {
  const response = await admin.graphql(
    `#graphql
      mutation PairingAnnotation($input: AnalyticsAnnotationCreateInput!) {
        analyticsAnnotationCreate(input: $input) {
          analyticsAnnotation { id title startedAt }
          userErrors { field message code }
        }
      }
    `,
    {
      apiVersion: ApiVersion.Unstable,
      variables: {
        input: {
          type: "campaign",
          title: input.title.slice(0, 75),
          description: input.description.slice(0, 150),
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  const payload = (await response.json()) as {
    data?: {
      analyticsAnnotationCreate?: {
        analyticsAnnotation?: { id: string } | null;
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  const result = payload.data?.analyticsAnnotationCreate;
  if (
    payload.errors?.length ||
    result?.userErrors?.length ||
    !result?.analyticsAnnotation
  ) {
    throw new Error(
      payload.errors?.map(({ message }) => message).join("; ") ||
        result?.userErrors?.map(({ message }) => message).join("; ") ||
        "Shopify did not create the analytics annotation.",
    );
  }
  return result.analyticsAnnotation;
}
