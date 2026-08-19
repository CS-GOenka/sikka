#!/usr/bin/env python3
"""One-off diagnostic: is chat.db missing today's ICICI messages, and does the
reconcile's read-only connection see fewer than a normal read-write one (the
SQLite WAL hypothesis)? Run in a Terminal that has Full Disk Access:

    python3 /Users/saurabhgoenka/sikka/scripts/chatdb_check.py
"""
import os
import sqlite3

DB = os.path.expanduser("~/Library/Messages/chat.db")
# nanoseconds since the Apple epoch (2001-01-01) for "now - 3 days"
SINCE_SQL = "date >= (strftime('%s','now','-3 day') - 978307200) * 1000000000"


def icici_rows(conn):
    conn.text_factory = lambda b: b.decode("utf-8", "replace") if isinstance(b, bytes) else b
    out = []
    for t, ab in conn.execute(f"SELECT text, attributedBody FROM message WHERE {SINCE_SQL}"):
        s = (t or "") + ((ab.decode("utf-8", "ignore")) if ab else "")
        if "icici" in s.lower():
            out.append(" ".join(s.split())[:100])
    return out


# Read-write (what a normal Terminal / the phone sync sees, incl. WAL)
rw = icici_rows(sqlite3.connect(DB))
# Read-only (exactly how reconcile_messages.py opens it)
ro = icici_rows(sqlite3.connect(f"file:{DB}?mode=ro", uri=True))

print(f"ICICI messages in chat.db, last 3 days:")
print(f"  read-write (full):     {len(rw)}")
print(f"  read-only (reconcile): {len(ro)}")
if len(rw) > len(ro):
    print("  => reconcile's read-only connection is MISSING messages (WAL issue).")
elif len(rw) == 0:
    print("  => none on the Mac at all (delivery/sync gap, not our code).")
else:
    print("  => reconcile sees everything the Mac has.")

print("\nMost recent ICICI messages the Mac has:")
for m in rw[-12:]:
    print("  " + m)
