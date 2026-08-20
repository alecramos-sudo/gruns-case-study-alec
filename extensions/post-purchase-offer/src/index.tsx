import { useEffect, useMemo, useState } from "react";
import {
  extend,
  render,
  useExtensionInput,
  BlockStack,
  Button,
  CalloutBanner,
  Heading,
  Image,
  Layout,
  Separator,
  Select,
  Text,
  TextBlock,
  TextContainer,
  TextField,
  Tiles,
  View,
} from "@shopify/post-purchase-ui-extensions-react";

const APP_URL = process.env.APP_URL;

function appEndpoint(path: string) {
  if (!APP_URL) throw new Error("The app URL is unavailable.");
  return new URL(path, APP_URL).toString();
}

type Offer = {
  id: string;
  productTitle: string;
  productImageURL: string;
  productDescription: string[];
  originalPrice: string;
  signalLabel: string;
  variants: Array<{
    variantId: number;
    title: string;
    price: string;
  }>;
  changes: Array<{
    type: "add_variant";
    variantId: number;
    quantity: number;
    discount: {
      value: number;
      valueType: "percentage";
      title: string;
    };
  }>;
};

type OfferStorage = { offers: Offer[] };

function storedOffer(value: unknown) {
  const offers = (value as Partial<OfferStorage> | null)?.offers;
  const offer = Array.isArray(offers) ? offers[0] : undefined;
  return offer?.id && offer.changes?.[0] && offer.variants?.length
    ? offer
    : null;
}

extend(
  "Checkout::PostPurchase::ShouldRender",
  async ({ inputData, storage }) => {
    try {
      const response = await fetch(appEndpoint("/api/offer"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${inputData.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          referenceId: inputData.initialPurchase.referenceId,
          shop: inputData.shop.domain,
          productIds: inputData.initialPurchase.lineItems.map(
            (lineItem) => lineItem.product.id,
          ),
        }),
      });
      if (!response.ok) return { render: false };
      const data = (await response.json()) as OfferStorage;
      if (!data.offers?.length) return { render: false };
      await storage.update(data);
      return { render: true };
    } catch {
      return { render: false };
    }
  },
);

render("Checkout::PostPurchase::Render", () => <App />);

export function App() {
  const { storage, done } =
    useExtensionInput<"Checkout::PostPurchase::Render">();
  const purchaseOption = storedOffer(storage.initialData);
  useEffect(() => {
    if (!purchaseOption) void done();
  }, [done, purchaseOption]);
  return purchaseOption ? (
    <OfferExperience purchaseOption={purchaseOption} />
  ) : null;
}

function OfferExperience({ purchaseOption }: { purchaseOption: Offer }) {
  const { inputData, calculateChangeset, applyChangeset, done } =
    useExtensionInput<"Checkout::PostPurchase::Render">();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [feedbackChoice, setFeedbackChoice] = useState("");
  const [feedbackText, setFeedbackText] = useState("");
  const [selectedVariantId, setSelectedVariantId] = useState(
    purchaseOption.changes[0].variantId,
  );
  const [calculatedPurchase, setCalculatedPurchase] =
    useState<
      Awaited<ReturnType<typeof calculateChangeset>>["calculatedPurchase"]
    >();

  async function postEvent(event: "impression" | "accepted" | "declined") {
    await fetch(appEndpoint("/api/offer-event"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${inputData.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        referenceId: inputData.initialPurchase.referenceId,
        shop: inputData.shop.domain,
        decisionId: purchaseOption.id,
        event,
        ...(event === "impression"
          ? {}
          : {
              feedbackChoice,
              feedbackText:
                feedbackChoice === "other"
                  ? feedbackText.trim().slice(0, 120)
                  : "",
            }),
      }),
    });
  }

  const selectedVariant =
    purchaseOption.variants.find(
      (variant) => variant.variantId === selectedVariantId,
    ) ?? purchaseOption.variants[0];
  const selectedChanges = useMemo(
    () =>
      purchaseOption.changes.map((change) => ({
        ...change,
        variantId: selectedVariantId,
      })),
    [purchaseOption.changes, selectedVariantId],
  );
  useEffect(() => {
    void postEvent("impression").catch(() => undefined);
    // The impression is tied to the decision, not variant changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void calculateChangeset({ changes: selectedChanges })
      .then((result) => {
        if (!active) return;
        if (result.status === "processed") {
          setCalculatedPurchase(result.calculatedPurchase);
        } else {
          setError(result.errors[0]?.message ?? "This offer is unavailable.");
        }
      })
      .catch(() => {
        if (active) setError("This offer is unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [calculateChangeset, selectedChanges]);

  const shipping =
    calculatedPurchase?.addedShippingLines[0]?.priceSet.presentmentMoney.amount;
  const taxes =
    calculatedPurchase?.addedTaxLines[0]?.priceSet.presentmentMoney.amount;
  const total = calculatedPurchase?.totalOutstandingSet.presentmentMoney.amount;
  const discountedPrice =
    calculatedPurchase?.updatedLineItems[0]?.totalPriceSet.presentmentMoney
      .amount;
  const originalPrice =
    calculatedPurchase?.updatedLineItems[0]?.priceSet.presentmentMoney.amount ??
    selectedVariant?.price ??
    purchaseOption.originalPrice;
  const currency =
    calculatedPurchase?.totalOutstandingSet.presentmentMoney.currencyCode ??
    inputData.initialPurchase.totalPriceSet.presentmentMoney.currencyCode;

  function formatCurrency(amount?: string) {
    if (!amount) return "—";
    return new Intl.NumberFormat(inputData.locale, {
      style: "currency",
      currency,
    }).format(Number(amount));
  }

  async function acceptOffer() {
    if (!calculatedPurchase) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(appEndpoint("/api/sign-changeset"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${inputData.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          referenceId: inputData.initialPurchase.referenceId,
          shop: inputData.shop.domain,
          decisionId: purchaseOption.id,
          variantId: selectedVariantId,
        }),
      });
      if (!response.ok) throw new Error("The offer could not be authorized.");
      const { token } = (await response.json()) as { token: string };
      const result = await applyChangeset(token);
      if (result.status === "unprocessed") {
        throw new Error(
          result.errors[0]?.message ?? "The offer was not added.",
        );
      }
      await postEvent("accepted").catch(() => undefined);
      setAccepted(true);
      setLoading(false);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The offer was not added.",
      );
      setLoading(false);
    }
  }

  if (accepted) {
    return (
      <BlockStack spacing="loose">
        <CalloutBanner title="Your order has been updated">
          {purchaseOption.productTitle} was added successfully.
        </CalloutBanner>
        <Button submit onPress={done}>
          Continue to order confirmation
        </Button>
      </BlockStack>
    );
  }

  async function declineOffer() {
    setLoading(true);
    await postEvent("declined").catch(() => undefined);
    await done();
  }

  return (
    <BlockStack spacing="loose">
      <CalloutBanner title="Your order is confirmed">
        <TextContainer>
          <Text size="medium">
            You can still add {purchaseOption.productTitle} with{" "}
          </Text>
          <Text size="medium" emphasized>
            {purchaseOption.changes[0].discount.title}
          </Text>
          <Text size="medium">.</Text>
        </TextContainer>
      </CalloutBanner>

      {error ? (
        <CalloutBanner title="We couldn’t add this offer">
          {error} You can continue to your order confirmation.
        </CalloutBanner>
      ) : null}

      <Layout
        media={[
          { viewportSize: "small", sizes: [1, 0, 1], maxInlineSize: 0.9 },
          { viewportSize: "medium", sizes: [532, 0, 1], maxInlineSize: 420 },
          { viewportSize: "large", sizes: [440, 32, 440] },
        ]}
      >
        <View>
          <Image
            description={purchaseOption.productTitle}
            source={purchaseOption.productImageURL}
            aspectRatio={4 / 3}
            fit="cover"
          />
        </View>
        <View />
        <BlockStack spacing="loose">
          <TextContainer>
            <Text subdued>{purchaseOption.signalLabel}</Text>
            <Heading>{purchaseOption.productTitle}</Heading>
          </TextContainer>

          <TextContainer alignment="leading" spacing="loose">
            <Text role="deletion" size="large">
              {formatCurrency(originalPrice)}
            </Text>
            <Text emphasized size="large" appearance="success">
              {` ${formatCurrency(discountedPrice)}`}
            </Text>
          </TextContainer>

          <BlockStack spacing="xtight">
            {purchaseOption.productDescription.map((line) => (
              <TextBlock key={line} subdued>
                {line}
              </TextBlock>
            ))}
          </BlockStack>

          {purchaseOption.variants.length > 1 ? (
            <Select
              label="Choose an option"
              value={String(selectedVariantId)}
              onChange={(value) => setSelectedVariantId(Number(value))}
              options={purchaseOption.variants.map((variant) => ({
                value: String(variant.variantId),
                label: variant.title,
              }))}
            />
          ) : null}

          <BlockStack spacing="tight">
            <Separator />
            <MoneyLine
              label="Subtotal"
              value={formatCurrency(discountedPrice)}
            />
            <MoneyLine label="Shipping" value={formatCurrency(shipping)} />
            <MoneyLine label="Taxes" value={formatCurrency(taxes)} />
            <Separator />
            <MoneyLine label="Total" value={formatCurrency(total)} emphasized />
          </BlockStack>

          <BlockStack spacing="tight">
            <Select
              label="What matters most to you? (optional)"
              placeholder="Choose one"
              value={feedbackChoice}
              onChange={setFeedbackChoice}
              options={[
                { value: "travel", label: "Travel convenience" },
                { value: "family", label: "Family routine" },
                { value: "daily_routine", label: "Daily routine" },
                { value: "brand_style", label: "Brand and style" },
                { value: "price", label: "Price" },
                { value: "not_relevant", label: "This is not relevant" },
                { value: "other", label: "Other" },
              ]}
            />
            {feedbackChoice === "other" ? (
              <BlockStack spacing="xtight">
                <TextField
                  label="Other reason (120 characters maximum)"
                  value={feedbackText}
                  onChange={(value) => setFeedbackText(value.slice(0, 120))}
                  autocomplete={false}
                />
                <TextBlock subdued>
                  Don’t include your name, email, phone number, or other
                  personal information.
                </TextBlock>
              </BlockStack>
            ) : null}
          </BlockStack>

          <BlockStack>
            <Button
              submit
              loading={loading}
              disabled={!calculatedPurchase || Boolean(error)}
              onPress={acceptOffer}
            >
              Pay now · {formatCurrency(total)}
            </Button>
            <Button subdued disabled={loading} onPress={declineOffer}>
              Decline upsell offer
            </Button>
            <TextBlock subdued>
              Pay now charges the payment method from your confirmed order.
            </TextBlock>
          </BlockStack>
        </BlockStack>
      </Layout>
    </BlockStack>
  );
}

function MoneyLine({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <Tiles>
      <TextBlock emphasized={emphasized}>{label}</TextBlock>
      <TextContainer alignment="trailing">
        <TextBlock emphasized={emphasized}>{value}</TextBlock>
      </TextContainer>
    </Tiles>
  );
}
