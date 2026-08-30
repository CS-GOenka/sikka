/**
 * The lookup key for the merchant_categories cache.
 *
 * The cache used to be keyed on the raw payee string, so one merchant split
 * across a row per spelling the bank happened to send. Swiggy alone held 16
 * rows - "Swiggy", "Swiggy Limited", "Www Swiggy", "RAZ*Swiggy", "Raz*swiggy",
 * "Ing*Swiggy" - and a manual correction on any one of them taught the system
 * nothing about the other fifteen.
 *
 * Three kinds of noise are folded out here, all of them artefacts of how the
 * charge was routed rather than anything about the merchant:
 *
 *   - casing and whitespace. ICICI sends both "RAZ*Swiggy" and "RAZ*SWIGGY",
 *     and cleanPayee() proper-cases the all-caps one to "Raz*swiggy" while
 *     leaving the mixed-case one alone, so they arrive here already different.
 *   - the payment-gateway prefix ("RAZ*", "CAS*", "IND*", "Ing*", "NEFT*"),
 *     which names the acquirer that processed the charge, not the merchant.
 *     Same 3-4 letter shape parseCodeName() strips in classify.ts.
 *   - "www" prefixes, ".com"/".in" tails, and legal-entity suffixes
 *     ("Limited", "Pvt Ltd", "Technologies").
 *
 * What it deliberately does NOT do is merge on a shared leading word. Folding
 * "Swiggy Instamar" (groceries) or "Swiggy Dineout" (a restaurant bill) into
 * plain Swiggy would file real spending under the wrong category, and the same
 * rule applied to people would collapse two different Subhams. Merchants whose
 * names genuinely differ stay separate unless ALIASES says otherwise.
 */

// The acquirer code in front of a "CODE*NAME" reference. Anchored and bounded
// to 3-4 letters so it cannot eat a merchant whose own name contains a star.
const GATEWAY_PREFIX = /^(?:info)?[a-z]{3,4}\*/;
const WWW_PREFIX = /^www[\s.]+/;
const DOMAIN_IN_NAME = /\.(?:com|in)\b/g;
const DOMAIN_TAIL = /\s+(?:com|in|co\.in)$/;
// Applied repeatedly, so "Swiggy Pvt Ltd" sheds both halves.
const LEGAL_SUFFIX =
  /\s+(?:private\s+limited|pvt\.?\s+ltd\.?|private|pvt\.?|limited|ltd\.?|llp|inc\.?|technologies|technology|tech)$/;
const TRAILING_PUNCTUATION = /[\s\-–—,.]+$/;

/**
 * Merchants the rules above cannot connect, because the difference is a word
 * rather than a routing artefact. Keep this short and evidence-based: each
 * entry is a claim that two names are one merchant, and a wrong claim silently
 * merges two budgets. Left side is a key that has already been normalized.
 */
const ALIASES: Record<string, string> = {
  // Swiggy's food-delivery arm bills under both names.
  "swiggy food": "swiggy",
};

export function payeeKey(payee: string): string {
  let s = payee.toLowerCase().replace(/\s+/g, " ").trim();
  s = s.replace(GATEWAY_PREFIX, "").trim();
  s = s.replace(WWW_PREFIX, "").trim();
  s = s.replace(DOMAIN_IN_NAME, " ").replace(/\s+/g, " ").trim();
  s = s.replace(DOMAIN_TAIL, "").trim();

  let previous: string;
  do {
    previous = s;
    s = s.replace(LEGAL_SUFFIX, "").trim();
  } while (s !== previous);

  s = s.replace(TRAILING_PUNCTUATION, "").trim();
  return ALIASES[s] ?? s;
}
