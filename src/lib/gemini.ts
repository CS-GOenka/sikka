import { GoogleGenAI } from "@google/genai";

const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
  throw new Error("Missing GEMINI_API_KEY environment variable");
}

// Server-only client. Never import this module from client components or
// expose this key with a NEXT_PUBLIC_ prefix.
export const gemini = new GoogleGenAI({ apiKey: geminiApiKey });

const MERCHANT_CATEGORIES = [
  "Food & Dining",
  "Groceries",
  "Transport",
  "Shopping",
  "Bills & Utilities",
  "Entertainment",
  "Travel",
  "Subscriptions",
  "Transfer",
  "Other",
] as const;

export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number];

export async function categorizeMerchant(payee: string): Promise<MerchantCategory> {
  const response = await gemini.models.generateContent({
    model: "gemma-4-31b-it",
    contents: `Classify the merchant/payee name below into exactly one of these categories:
${MERCHANT_CATEGORIES.join(", ")}

Merchant: ${payee}

Respond with only the category name, nothing else.`,
  });

  const category = response.text?.trim();
  if (category && (MERCHANT_CATEGORIES as readonly string[]).includes(category)) {
    return category as MerchantCategory;
  }
  return "Other";
}
