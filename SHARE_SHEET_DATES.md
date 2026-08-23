# Share-Sheet captures were dated by share time, not by the message

Status: **code fixed, data corrected, one action still needed on the phone.**
Branch `sharesheet-date-precedence`, not yet merged or deployed.

---

## What went wrong

Three transactions whose SMS text says `22-Aug-26` were filed under 23 Aug — the
moment they were shared through the Send-to-Sikka Share Sheet.

**The date parsing was never at fault.** `transaction_date` on all three reads
`2026-08-22`, correctly parsed from the message. What was wrong was
`phone_received_at`, and that is the column every spend query ranges over
(`computeTodaySpend`, the dashboard's period windows, `/capture-check`), so the
spend landed on the wrong budget day while the transaction itself looked right.

The cause was one line in the ingest route:

```js
const effectivePhoneReceivedAt = phoneReceivedAt ?? fallbackReceivedAt(classified.transactionDate);
```

`??` means a supplied timestamp always wins. Adding **Current Date** to the
Share Sheet Shortcut started supplying one, which defeated a fallback that had
been handling this correctly while the Share Sheet sent nothing.

### The evidence

| txn | message says | stored `phone_received_at` | server insert time |
|-----|--------------|----------------------------|--------------------|
| 5028 | 22-Aug-26 | `2026-08-23T10:02:00.000Z` | 10:02:23.598 |
| 5029 | 22-Aug-26 | `2026-08-23T10:02:00.000Z` | 10:02:37.694 |
| 5030 | 22-Aug-26 | `2026-08-23T10:02:00.000Z` | 10:02:46.377 |

All three carry the *identical* stamp (15:32:00 IST) while their insert times are
23 seconds apart — one share batch, all stamped with the same minute-precision
"Current Date". The fallback would have produced distinct sub-second times per
row. Override, conclusively — not a parse failure.

---

## The fix

A manual capture is dated by its message text; the automatic path is untouched.

```
manual capture   + a usable past date in the text  ->  midday IST on that date
manual capture   + today's date / no date          ->  the supplied timestamp
automatic / reconcile                              ->  the supplied timestamp, always
```

Midday IST because it sits safely inside a budget day whatever the reset hour,
unlike midnight, which the 03:00 reset would push into the day before. Today's
date keeps a live timestamp because that is what puts a row inside
`/capture-check`'s rolling 1h/6h windows.

The logic moved out of the ingest route into **`src/lib/receivedAt.ts`** so it
could be tested directly. It is, across both paths:

```
PASS  BUG: Share Sheet, 22-Aug SMS shared on 23-Aug  -> 22 Aug 12:00 IST
PASS  Share Sheet, same-day SMS (keeps live time)    -> 23 Aug 15:32 IST
PASS  Share Sheet, no parseable date                 -> 23 Aug 15:32 IST
PASS  Share Sheet, no timestamp sent at all          -> 22 Aug 12:00 IST
PASS  AUTO: real-time SMS, same day                  -> 23 Aug 15:32 IST
PASS  AUTO: late refund SMS (arrives days later)     -> 23 Aug 15:32 IST
PASS  AUTO: reconcile, true past receipt instant     -> 20 Aug 22:14 IST
PASS  AUTO: no timestamp, backdated SMS              -> 21 Aug 12:00 IST
```

### Why the server cannot just detect this itself

The Share Sheet and the SMS automation post the **same body shape** and the
**same IST human date format**, so the payload alone cannot separate them.

Minute-precision timestamps looked like a clean signal and were rejected on
evidence: real-time captures 5005–5008 carry `:00.000` too. That is a property of
the iOS date format *both* Shortcuts use, not of the Share Sheet. Building on it
would have misclassified every real-time capture.

So a manual capture has to declare itself: **`source: "manual"`** (also accepted:
`share`, `share-sheet`, `sharesheet`, `share_sheet`).

### Why the obvious rule would have been wrong

"A message dated before its receipt time must be misdated" is **false**. Fourteen
credit rows are bank refund notices genuinely sent up to three days after the
refund date they quote — e.g.

> `BLINKIT refund of Rs 449.00 credited to ICICI Bank Credit Card XX2003 on 27-SEP-25.`
> received 30 Sep

Their receipt times are correct. Keying on a declared source leaves them alone,
and a test asserts it.

---

## Data corrected

Four debits/credits, all set to midday IST on the date in their own message.
Full scan of **2,847** dated transactions; **zero** mis-dated debits remain.

| txn | | amount | payee | was | now |
|-----|---|--------|-------|-----|-----|
| 4963 | debit | ₹120 | Kamlesh Vaid | 07 Aug 20:19 | **06 Aug 12:00** |
| 5028 | credit | ₹1,623 | Nipun Singhal | 23 Aug 15:32 | **22 Aug 12:00** |
| 5029 | debit | ₹40 | Aadri | 23 Aug 15:32 | **22 Aug 12:00** |
| 5030 | debit | ₹3,321.53 | Sri Vara | 23 Aug 15:32 | **22 Aug 12:00** |

Budget-day spend after correction:

```
 6 Aug:          ₹120        21 Aug:        ₹3,500
 7 Aug:          ₹280        22 Aug:     ₹3,361.53
                             23 Aug:           ₹79
```

---

## Open points

### 1. The Shortcut still needs one edit — the fix is inert until then

New Share-Sheet captures will **still** be stamped with the share time until the
Shortcut identifies itself. Either:

- **add** `source` = `manual` to the dictionary the Shortcut posts, alongside
  `message` — preferred, it is explicit; or
- **remove** "Current Date" from that Shortcut — the fallback already handles the
  absent case correctly.

### 2. Fourteen credit rows left untouched, deliberately

Late bank refund notices (Swiggy, Blinkit, YouTube, IRCTC, Cred Garage…), dated
correctly as stored. They are credits, so they do not affect spend in any case.
Listed in the scan if you want to revisit — but changing them would replace
correct receipt times with worse ones.

### 3. Not merged or deployed

Branch `sharesheet-date-precedence` is pushed but `main` is still at `363c0f9`.
The data corrections are already live in the database, so production currently
runs the old precedence rule against corrected rows — which is stable, just not
yet protected against the next backdated share.

### 4. Worth considering later

- **`/capture-check` blind spot.** It ranges over `phone_received_at` on rolling
  1h/6h windows, so a corrected backdated capture drops out of it immediately.
  That is intended, but it means a manual capture cannot be confirmed there.
- **No automated test suite.** `receivedAt.ts` was verified by compiling and
  running it directly; there is no `npm test` to keep that honest as the code
  moves. This is the second dating bug in this area, so a permanent test would
  earn its keep.
