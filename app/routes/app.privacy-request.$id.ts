import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const privacyRequest = await prisma.customerDataRequest.findFirst({
    where: { id: params.id, shop: session.shop },
  });
  if (!privacyRequest) throw new Response("Not found", { status: 404 });

  return new Response(privacyRequest.data, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="customer-data-${privacyRequest.requestId}.json"`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
};
