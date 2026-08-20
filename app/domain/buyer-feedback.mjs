export const BUYER_FEEDBACK_CHOICES = new Set([
  "travel",
  "family",
  "daily_routine",
  "brand_style",
  "price",
  "not_relevant",
  "other",
]);

function redactPersonalInformation(value) {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[removed]")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[removed]")
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, "[removed]");
}

export function normalizeBuyerFeedback(choice, text) {
  const normalizedChoice = String(choice ?? "").trim();
  if (!normalizedChoice) return { choice: null, text: null };
  if (!BUYER_FEEDBACK_CHOICES.has(normalizedChoice)) {
    throw new Error("Choose a valid feedback option.");
  }
  if (normalizedChoice !== "other") {
    return { choice: normalizedChoice, text: null };
  }
  const normalizedText = redactPersonalInformation(String(text ?? "").trim())
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return { choice: normalizedChoice, text: normalizedText || null };
}
