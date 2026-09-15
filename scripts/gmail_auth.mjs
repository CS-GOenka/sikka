#!/usr/bin/env node
// One-time Gmail authorisation. Prints the consent URL, catches the redirect
// on localhost, and prints the refresh token for you to paste into Vercel.
//
//   node scripts/gmail_auth.mjs
//
// Deliberately local and deliberately not a route in the app. A production
// endpoint that mints and displays refresh tokens is a credential-printing URL
// sitting on the public internet; running the exchange here means the token
// never transits the deployed app at all.
//
// Requires http://localhost:53682/callback as an Authorised redirect URI on
// the OAuth client in Google Cloud Console.
import http from "node:http";
import fs from "node:fs";
import { buildAuthUrl, exchangeCode } from "../src/lib/gmail/auth.ts";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const clientId = env.GOOGLE_CLIENT_ID;
const clientSecret = env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be in .env.local");
  process.exit(1);
}

// Tying the callback to a value only this process knows, so a stray request to
// the open port cannot feed it somebody else's authorisation code.
const state = Math.random().toString(36).slice(2);
const url = buildAuthUrl(clientId, REDIRECT_URI, state);

console.log("\nOpen this URL in a browser and authorise:\n");
console.log(url);
console.log("\nWaiting for the redirect on " + REDIRECT_URI + " …\n");

const server = http.createServer(async (req, res) => {
  const incoming = new URL(req.url, `http://localhost:${PORT}`);
  if (incoming.pathname !== "/callback") { res.writeHead(404).end(); return; }

  const error = incoming.searchParams.get("error");
  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`Authorisation failed: ${error}`);
    console.error("Authorisation failed:", error);
    server.close(); process.exit(1);
  }
  if (incoming.searchParams.get("state") !== state) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("State mismatch - ignoring.");
    console.error("State mismatch; ignoring this callback.");
    return;
  }

  try {
    const token = await exchangeCode(
      incoming.searchParams.get("code"), clientId, clientSecret, REDIRECT_URI
    );
    res.writeHead(200, { "Content-Type": "text/plain" })
       .end("Authorised. The refresh token has been printed in your terminal - you can close this tab.");

    console.log("scope granted :", token.scope);
    console.log("access token  : obtained, expires in " + token.expires_in + "s");
    if (token.refresh_token) {
      console.log("\nrefresh token :\n\n" + token.refresh_token + "\n");
      console.log("Add it as GOOGLE_REFRESH_TOKEN in .env.local and in Vercel's env vars.\n");
    } else {
      console.error("\nNO REFRESH TOKEN RETURNED.");
      console.error("Google omits it when the app has already been authorised and prompt=consent");
      console.error("was not sent. Revoke Sikka at https://myaccount.google.com/permissions and retry.\n");
    }
  } catch (err) {
    console.error("Token exchange failed:", err.message);
    res.writeHead(500, { "Content-Type": "text/plain" }).end("Token exchange failed - see terminal.");
  }
  server.close();
  process.exit(0);
});
server.listen(PORT);
