import { GoogleGenAI } from "@google/genai";

const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
  throw new Error("Missing GEMINI_API_KEY environment variable");
}

// Server-only client. Never import this module from client components or
// expose this key with a NEXT_PUBLIC_ prefix.
export const gemini = new GoogleGenAI({ apiKey: geminiApiKey });

export const MERCHANT_CATEGORIES = [
  "Food & Dining",
  "Groceries/Quick Commerce",
  "Subscriptions",
  "Transport & Fuel",
  "Shopping",
  "Healthcare",
  "Travel",
  "Utilities & Bills",
  "Rent",
  "Person-to-Person",
  "Cash Withdrawal",
  "Other",
] as const;

export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number];

// Returns category=null when Gemma's response doesn't cleanly match one of
// the fixed categories, so callers can flag it for review instead of
// silently mislabeling it.
export async function categorizeMerchant(payee: string): Promise<MerchantCategory | null> {
  const response = await gemini.models.generateContent({
    model: "gemma-4-26b-a4b-it",
    contents: `Classify the merchant/payee name below into exactly one of these categories:
${MERCHANT_CATEGORIES.join(", ")}

Merchant: ${payee}

Respond with only the category name, nothing else.`,
  });

  const category = response.text?.trim();
  if (category && (MERCHANT_CATEGORIES as readonly string[]).includes(category)) {
    return category as MerchantCategory;
  }
  return null;
}
