#!/usr/bin/env python3
"""
Reconciliation safety net for the SMS-forwarding pipeline.

The Shortcut automation that forwards ICICI Bank SMS from this Mac's
~/Library/Messages/chat.db to /api/ingest has been observed to silently miss
messages (no error, no retry - the message just never arrives). This script
is the mitigation: it periodically re-scans chat.db for ICICI Bank messages
and re-POSTs every one of them to the real production /api/ingest endpoint.

It does NOT need to check what's already been ingested - /api/ingest is
idempotent (dedupes on exact message text), so re-sending an
already-processed message is always a safe no-op.

This is a *safety net*, not a fix for the Shortcut itself - the Shortcut's
automation reliability (e.g. "Run Immediately" vs "Ask Before Running",
Focus modes suppressing the prompt) still needs to be checked on the phone
directly; this script only guarantees no message is permanently lost while
that's investigated.

Run periodically via launchd - see scripts/com.sikka.reconcile.plist.
Meant to run only on this Mac (chat.db access required); never deployed.
"""

import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta

BASE_URL = "https://sikka-mauve.vercel.app"
DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
INGEST_URL = f"{BASE_URL}/api/ingest"
TARGET = "icici bank"
# 10 days (not 7) so a delayed iCloud/Messages sync still lands inside the
# window whenever it eventually completes, rather than aging out permanently.
LOOKBACK_DAYS = 10

SENSITIVE_PATTERNS = [
    re.compile(r"otp", re.I),
    re.compile(r"one.?time.?password", re.I),
    re.compile(r"do not (disclose|share)", re.I),
    re.compile(r"verification code", re.I),
    re.compile(r"security code", re.I),
]


def extract_text_from_attributed_body(blob):
    if not blob:
        return None
    try:
        marker = b"NSString"
        idx = blob.find(marker)
        if idx == -1:
            return None
        idx += len(marker)
        i = idx
        limit = min(len(blob) - 1, idx + 20)
        found = -1
        while i < limit:
            if blob[i] == 0x2B:
                found = i
                break
            i += 1
        if found == -1:
            return None
        i = found + 1
        length_byte = blob[i]
        i += 1
        if length_byte == 0x81:
            length = int.from_bytes(blob[i:i + 2], "little")
            i += 2
        elif length_byte == 0x82:
            length = int.from_bytes(blob[i:i + 4], "little")
            i += 4
        elif length_byte & 0x80:
            return None
        else:
            length = length_byte
        return blob[i:i + length].decode("utf-8", errors="replace")
    except Exception:
        return None


def get_message_text(text_col, attributed_body):
    if text_col:
        return text_col
    extracted = extract_text_from_attributed_body(attributed_body)
    if extracted:
        return extracted
    if attributed_body:
        raw = attributed_body.decode("utf-8", errors="ignore")
        lower = raw.lower()
        if TARGET in lower:
            pos = lower.find(TARGET)
            window = raw[max(0, pos - 200):pos + 200]
            printable_run = re.search(r"[\x20-\x7E]{20,}", window)
            cleaned = printable_run.group(0) if printable_run else window
            cleaned = re.sub(r"\s+", " ", cleaned).strip()
            if TARGET in cleaned.lower():
                return cleaned
    return None


def is_sensitive(text):
    return any(p.search(text) for p in SENSITIVE_PATTERNS)


APPLE_EPOCH = datetime(2001, 1, 1)


def apple_ns_to_iso(apple_ns):
    # chat.db's `date` column is nanoseconds since the Apple epoch
    # (2001-01-01 UTC) on modern macOS. This is the actual time this Mac's
    # Messages app received the SMS - a real, precise timestamp, unlike the
    # Shortcut's own phoneReceivedAt (a human-readable string of uncertain
    # format sent inconsistently).
    seconds = apple_ns / 1_000_000_000
    return (APPLE_EPOCH + timedelta(seconds=seconds)).isoformat() + "Z"


def fetch_recent_icici_messages():
    start_dt = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    start_ns = int((start_dt - APPLE_EPOCH).total_seconds() * 1_000_000_000)

    uri = f"file:{DB_PATH}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.text_factory = lambda b: b.decode("utf-8", errors="replace") if isinstance(b, bytes) else b
    cur = conn.cursor()
    cur.execute(
        "SELECT text, attributedBody, date FROM message "
        "WHERE date >= ? AND is_from_me = 0 "
        "AND (text LIKE '%ICICI%' COLLATE NOCASE OR attributedBody IS NOT NULL)",
        (start_ns,),
    )

    messages = []
    skipped = []  # (reason, snippet, iso) for chat.db rows that look ICICI-ish but were dropped
    for text_col, attributed_body, msg_date in cur:
        full_text = get_message_text(text_col, attributed_body)
        # Diagnostic probe of the raw row (text + best-effort blob decode) so we
        # can tell "message not on the Mac at all" from "on the Mac but our
        # extraction dropped it".
        raw_probe = (text_col or "")
        if attributed_body:
            raw_probe += " " + attributed_body.decode("utf-8", errors="ignore")
        low_probe = raw_probe.lower()
        looks_iciciish = ("icici" in low_probe) or ("credit card" in low_probe)

        if not full_text or TARGET not in full_text.lower():
            if looks_iciciish:
                skipped.append(("no_extract_or_no_target", (full_text or raw_probe)[:120], apple_ns_to_iso(msg_date)))
            continue
        if is_sensitive(full_text):
            skipped.append(("sensitive", full_text[:120], apple_ns_to_iso(msg_date)))
            continue
        messages.append((full_text, apple_ns_to_iso(msg_date)))
    conn.close()
    return messages, skipped


def post_message(message, phone_received_at):
    body = json.dumps({"message": message, "phoneReceivedAt": phone_received_at}).encode()
    req = urllib.request.Request(
        INGEST_URL, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return None, str(e)


def post_health(path, payload=None):
    # Best-effort health signal to the app. Never lets a health call break the
    # reconcile itself.
    try:
        data = json.dumps(payload or {}).encode()
        req = urllib.request.Request(
            f"{BASE_URL}{path}", data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as e:
        print(f"  health post to {path} failed: {e}", file=sys.stderr)


def main():
    messages, skipped = fetch_recent_icici_messages()
    print(f"{datetime.utcnow().isoformat()}Z: scanning last {LOOKBACK_DAYS} days, "
          f"found {len(messages)} ICICI messages to re-sync")

    # Diagnostic: surface anything that reached chat.db but we chose not to send.
    # An expected message showing up here means our extraction/filter is the
    # culprit; a message that never appears in either list means it never made
    # it onto the Mac (Text Message Forwarding / Shortcut gap).
    if skipped:
        print(f"  {len(skipped)} ICICI-looking chat.db rows were skipped (not sent):")
        for reason, snippet, iso in skipped:
            print(f"    SKIP[{reason}] {iso}: {snippet!r}")

    ok = 0
    failed = 0
    for msg, phone_received_at in messages:
        status, body = post_message(msg, phone_received_at)
        if status == 200:
            ok += 1
        else:
            failed += 1
            print(f"  FAILED (status={status}): {msg[:80]!r} -> {body[:200]}", file=sys.stderr)

    print(f"{datetime.utcnow().isoformat()}Z: done. {ok} OK, {failed} failed")

    # Heartbeat: a successful chat.db read + re-sync. The app flags ingestion
    # as stale (banner) if this stops arriving, so an outage can't hide.
    post_health("/api/health/ping")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # e.g. sqlite3 "authorization denied" when Full Disk Access is revoked.
        # Alert immediately instead of failing silently for days.
        print(f"{datetime.utcnow().isoformat()}Z: FATAL {type(e).__name__}: {e}", file=sys.stderr)
        post_health("/api/health/alert", {"message": f"Reconcile failed: {type(e).__name__}: {e}"})
        raise
