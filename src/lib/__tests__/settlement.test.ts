// Group settlement arithmetic.
//
// This decides what counts as my spending, so an error here is invisible and
// systematic: totals stay plausible while being wrong. The two worked examples
// from the brief are pinned exactly, alongside the cases that would quietly
// corrupt a total.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  deriveStatus, groupAnchor, groupCategory, groupGross, groupNet, groupOwed,
  groupShares, groupSpendContribution, reconcile, type SettlementGroup,
} from "../settlement.ts";

// groupShares is what the group card subtracts on screen, so it is asserted
// directly rather than only through groupNet.

const txn = (over: Partial<SettlementGroup["transactions"][0]> = {}) => ({
  id: 1, type: "debit", status: "success", currency: "INR",
  amount: 5000, receivedAt: "2026-08-20T10:00:00.000Z", categoryId: 21, ...over,
});
const group = (over: Partial<SettlementGroup> = {}): SettlementGroup => ({
  id: 1, name: "Group", status: "open", createdAt: "2026-08-20T10:00:00.000Z",
  transactions: [], lines: [], ...over,
});

describe("the dinner case - I fronted a shared cost", () => {
  // I paid Rs 5,000; four people owe Rs 1,000 each; my share is Rs 1,000.
  const dinner = group({
    name: "Dinner",
    transactions: [txn({ amount: 5000 })],
    lines: [1, 2, 3, 4].map((i) => ({ id: i, person: `P${i}`, share: 1000, status: "open" as const })),
  });

  test("gross is what left my account", () => {
    assert.equal(groupGross(dinner), 5000);
  });

  test("REGRESSION: my spend is Rs 1,000, not Rs 5,000", () => {
    // 5000 - 0 - 4000. The other Rs 4,000 was never mine to spend.
    assert.equal(groupNet(dinner), 1000);
    assert.equal(groupSpendContribution(dinner), 1000, "a positive net is spent normally");
  });

  test("Rs 4,000 is owed to me while the lines are open", () => {
    assert.equal(groupOwed(dinner), 4000);
    assert.equal(groupShares(dinner), 4000);
  });

  test("REGRESSION: settling a line does not change my spend", () => {
    // Being repaid changes who holds the money, not whether I spent it. If
    // settled lines stopped counting, my past spending would climb every time
    // somebody paid me back.
    const settled = group({
      ...dinner,
      lines: dinner.lines.map((l) => ({ ...l, status: "settled" as const })),
    });
    assert.equal(groupNet(settled), 1000, "spend must be unchanged by settlement");
    assert.equal(groupOwed(settled), 0, "but nothing is owed any more");
  });

  test("settling one line reduces only what is owed", () => {
    const partly = group({
      ...dinner,
      lines: dinner.lines.map((l, i) => (i === 0 ? { ...l, status: "settled" as const } : l)),
    });
    assert.equal(groupOwed(partly), 3000);
    assert.equal(groupNet(partly), 1000);
  });

  test("it stays open until every line settles", () => {
    assert.equal(deriveStatus(dinner.lines), "open");
    assert.equal(deriveStatus(dinner.lines.map((l) => ({ ...l, status: "settled" as const }))), "closed");
  });

  test("uneven splits are allowed and simply change my share", () => {
    const uneven = group({
      transactions: [txn({ amount: 5000 })],
      lines: [
        { id: 1, person: "A", share: 1200, status: "open" },
        { id: 2, person: "B", share: 800, status: "open" },
      ],
    });
    assert.equal(groupNet(uneven), 3000);
    assert.equal(reconcile(uneven), null, "an uneven split is not an error");
  });
});

describe("the poker case - I was a pass-through pot", () => {
  // Rs 5,000 came in across several credits, Rs 4,650 went back out.
  const poker = group({
    name: "Poker",
    transactions: [
      txn({ id: 1, type: "credit", amount: 3000, receivedAt: "2026-08-20T10:00:00.000Z" }),
      txn({ id: 2, type: "credit", amount: 2000, receivedAt: "2026-08-20T11:00:00.000Z" }),
      txn({ id: 3, type: "debit", amount: 2650, receivedAt: "2026-08-20T18:00:00.000Z" }),
      txn({ id: 4, type: "debit", amount: 2000, receivedAt: "2026-08-20T19:00:00.000Z" }),
    ],
    lines: [],
  });

  test("the net is -Rs 350 and stays visible as the group's own figure", () => {
    // 4650 - 5000 - 0. The group keeps this: it is what the groups tab shows.
    assert.equal(groupNet(poker), -350);
    assert.equal(groupGross(poker), -350);
  });

  test("REGRESSION: a win contributes ZERO to spend, not a negative", () => {
    // A gain is not an expense. Letting -350 through would quietly fund other
    // spending - a good night at cards making a week of restaurants look
    // cheaper - and would ask the pie to draw a slice with no proportion.
    assert.equal(groupSpendContribution(poker), 0);
  });

  test("a poker LOSS is an ordinary expense", () => {
    // Took in Rs 4,000, paid out Rs 4,350: net +Rs 350, which is real spend.
    const loss = group({
      transactions: [
        txn({ id: 1, type: "credit", amount: 4000 }),
        txn({ id: 2, type: "debit", amount: 4350 }),
      ],
    });
    assert.equal(groupNet(loss), 350);
    assert.equal(groupSpendContribution(loss), 350);
  });

  test("REGRESSION: a group with no lines is born closed", () => {
    // There is nobody to chase, so it must not sit in the open list forever.
    assert.equal(deriveStatus(poker.lines), "closed");
    assert.equal(groupOwed(poker), 0);
  });
});

describe("what counts inside a group", () => {
  test("failed and non-INR transactions are ignored", () => {
    const g = group({
      transactions: [
        txn({ id: 1, amount: 5000 }),
        txn({ id: 2, amount: 9999, status: "failed" }),
        txn({ id: 3, amount: 100, currency: "USD" }),
        txn({ id: 4, amount: null }),
      ],
    });
    assert.equal(groupGross(g), 5000);
  });

  test("an 'ignored' classification contributes nothing either way", () => {
    const g = group({ transactions: [txn({ amount: 5000 }), txn({ id: 2, type: "ignored", amount: 400 })] });
    assert.equal(groupGross(g), 5000);
  });
});

describe("placing the group in time and in a category", () => {
  test("the anchor is the EARLIEST transaction, so it cannot move", () => {
    // A group is one economic event; attributing its net to a single instant
    // stops a period boundary splitting a settlement in half. The earliest is
    // used because the latest would shift as transactions are added.
    const g = group({
      transactions: [
        txn({ id: 1, receivedAt: "2026-08-22T10:00:00.000Z" }),
        txn({ id: 2, receivedAt: "2026-08-20T10:00:00.000Z" }),
        txn({ id: 3, receivedAt: "2026-08-21T10:00:00.000Z" }),
      ],
    });
    assert.equal(groupAnchor(g), "2026-08-20T10:00:00.000Z");
  });

  test("the category is the one carrying the largest debit", () => {
    const g = group({
      transactions: [
        txn({ id: 1, amount: 500, categoryId: 19 }),
        txn({ id: 2, amount: 5000, categoryId: 21 }),
        txn({ id: 3, type: "credit", amount: 9000, categoryId: 47 }),
      ],
    });
    assert.equal(groupCategory(g), 21, "a credit must not decide the category");
  });

  test("a group with nothing usable has no anchor", () => {
    assert.equal(groupAnchor(group()), null);
  });
});

describe("reconciliation is advisory", () => {
  test("REGRESSION: a group with no shares never warns", () => {
    // A pot that came out ahead has a negative gross, and zero shares are
    // trivially "more than" a negative number - so the poker win warned about
    // a split it does not have.
    const win = group({
      transactions: [
        txn({ id: 1, type: "credit", amount: 5000 }),
        txn({ id: 2, type: "debit", amount: 4650 }),
      ],
    });
    assert.equal(groupGross(win), -350);
    assert.equal(reconcile(win), null, "no lines means nothing to reconcile");
  });

  test("warns only when shares exceed what was actually spent", () => {
    const g = group({
      transactions: [txn({ amount: 1000 })],
      lines: [{ id: 1, person: "A", share: 1500, status: "open" }],
    });
    const w = reconcile(g);
    assert.equal(w?.kind, "shares-exceed-gross");
    assert.equal(w?.gross, 1000);
    assert.equal(w?.shares, 1500);
    // Still computes, because the warning must not block a real split - and a
    // net that lands below zero contributes nothing rather than a negative.
    assert.equal(groupNet(g), -500);
    assert.equal(groupSpendContribution(g), 0);
  });
});

describe("rounding", () => {
  test("nets land on whole paisa", () => {
    const g = group({
      transactions: [txn({ amount: 3321.53 }), txn({ id: 2, type: "credit", amount: 1107.18 })],
      lines: [{ id: 1, person: "A", share: 738.11, status: "open" }],
    });
    const net = groupNet(g);
    assert.equal(net, Math.round(net * 100) / 100);
    assert.equal(net, 1476.24);
  });
});
