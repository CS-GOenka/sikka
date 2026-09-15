/**
 * The readable text of a Gmail message.
 *
 * ICICI's alerts are multipart with an HTML part and, usually, no plain-text
 * one - 984 of 984 in the 24-month backfill resolved to `text/html (tags
 * stripped)`. So the HTML path is the normal path here, not the fallback, and
 * the stripping has to be good enough to parse money out of.
 *
 * Entities are decoded AFTER tags are removed, in that order deliberately: a
 * `&lt;` decoded first would become a `<` and then be eaten as the start of a
 * tag, silently swallowing everything up to the next `>`.
 */
export interface MessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: MessagePart[];
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export interface ExtractedBody {
  /** Which part this came from, kept for the staging row's provenance. */
  source: "text/plain" | "text/html (tags stripped)" | "none";
  text: string;
}

export function extractBody(payload: MessagePart | undefined): ExtractedBody {
  const found: { type: "plain" | "html"; text: string }[] = [];
  const walk = (p?: MessagePart): void => {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data) found.push({ type: "plain", text: decodeBase64Url(p.body.data) });
    if (p.mimeType === "text/html" && p.body?.data) found.push({ type: "html", text: decodeBase64Url(p.body.data) });
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);

  const plain = found.find((p) => p.type === "plain");
  if (plain) return { source: "text/plain", text: plain.text };

  const html = found.find((p) => p.type === "html");
  if (html) {
    const stripped = html.text
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&#39;/g, "'")
      .replace(/&rsquo;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    return { source: "text/html (tags stripped)", text: stripped };
  }
  return { source: "none", text: "" };
}
