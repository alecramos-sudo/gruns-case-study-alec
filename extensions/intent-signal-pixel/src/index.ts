import { register } from "@shopify/web-pixels-extension";

const STORAGE_KEY = "gruns_recently_viewed";

function parseHistory(value: string | null) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

register(({ analytics, browser, settings }) => {
  analytics.subscribe("product_viewed", (event) => {
    const productId = event.data.productVariant.product.id;
    if (!productId) return;
    void browser.localStorage
      .getItem(STORAGE_KEY)
      .then((stored) => {
        const history = parseHistory(stored).filter(
          (candidate) => candidate !== productId,
        );
        return browser.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([productId, ...history].slice(0, 5)),
        );
      })
      .catch(() => undefined);
  });

  analytics.subscribe("checkout_started", (event) => {
    const checkoutToken = event.data.checkout.token;
    if (
      !checkoutToken ||
      !settings.endpoint ||
      !settings.shop ||
      !settings.token
    ) {
      return;
    }

    void browser.localStorage
      .getItem(STORAGE_KEY)
      .then((stored) =>
        fetch(String(settings.endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({
            token: settings.token,
            shop: settings.shop,
            checkoutToken,
            recentlyViewed: parseHistory(stored).slice(0, 5),
          }),
        }),
      )
      .catch(() => undefined);
  });
});
