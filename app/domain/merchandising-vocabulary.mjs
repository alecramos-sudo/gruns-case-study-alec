export const MERCHANDISING_ROLES = [
  "nutrition",
  "apparel",
  "headwear",
  "carry",
  "hydration",
  "routine_accessory",
  "brand_accessory",
];

export const MERCHANDISING_ROLE_OPTIONS = [
  { value: "nutrition", label: "Nutrition" },
  { value: "apparel", label: "Apparel" },
  { value: "headwear", label: "Headwear" },
  { value: "carry", label: "Bags and carry" },
  { value: "hydration", label: "Hydration" },
  { value: "routine_accessory", label: "Routine accessory" },
  { value: "brand_accessory", label: "Brand accessory" },
];

export function isMerchandisingRole(value) {
  return MERCHANDISING_ROLES.includes(value);
}

export function merchandisingRoleLabel(value) {
  return (
    MERCHANDISING_ROLE_OPTIONS.find((option) => option.value === value)
      ?.label ?? value.replaceAll("_", " ")
  );
}

export function inferMerchandisingRole(product) {
  const text = [product.title, product.productType, ...(product.tags ?? [])]
    .join(" ")
    .toLowerCase();

  if (/gummy|nutrition|supplement|vitamin/.test(text)) return "nutrition";
  if (/hoodie|tee|shirt|bandana|apparel/.test(text)) return "apparel";
  if (/hat|cap|headwear/.test(text)) return "headwear";
  if (/tote|lunchbox|lunch box|bag|carry/.test(text)) return "carry";
  if (/bottle|hydration/.test(text)) return "hydration";
  if (/tin|tray|organizer|routine/.test(text)) return "routine_accessory";
  return "brand_accessory";
}
