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

DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
INGEST_URL = "https://sikka-mauve.vercel.app/api/ingest"
TARGET = "icici bank"
LOOKBACK_DAYS = 7

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
    for text_col, attributed_body, msg_date in cur:
        full_text = get_message_text(text_col, attributed_body)
        if not full_text or TARGET not in full_text.lower():
            continue
        if is_sensitive(full_text):
            continue
        messages.append((full_text, apple_ns_to_iso(msg_date)))
    conn.close()
    return messages


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


def main():
    messages = fetch_recent_icici_messages()
    print(f"{datetime.utcnow().isoformat()}Z: scanning last {LOOKBACK_DAYS} days, "
          f"found {len(messages)} ICICI messages to re-sync")

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


if __name__ == "__main__":
    main()
