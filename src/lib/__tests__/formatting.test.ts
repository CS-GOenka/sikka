// Money and age, as they reach the screen.
//
// Both of these are the kind of thing that looks obviously right until a real
// value lands on it: an amount exact to the paisa losing its trailing zero, or
// a late-night transaction reading "0 days" well into the next afternoon.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatInr } from "../formatInr.ts";
import { formatAge, istAgeInDays, istDateWithAge } from "../formatIst.ts";

describe("formatInr", () => {
  test("keeps the trailing zero on an exact paisa amount", () => {
    // The case this was written for: 106.9 and 106.90 are the same number, but
    // only one of them lines up in a column of amounts.
    assert.equal(formatInr(106.9), "₹106.90");
  });

  test("always shows paise, even on a whole rupee amount", () => {
    assert.equal(formatInr(2500), "₹2,500.00");
    assert.equal(formatInr(0), "₹0.00");
  });

  test("groups in the Indian style, not the western one", () => {
    assert.equal(formatInr(280876), "₹2,80,876.00");
    assert.equal(formatInr(20733.4), "₹20,733.40");
  });

  test("rounds to the paisa rather than truncating", () => {
    assert.equal(formatInr(106.905), "₹106.91");
    assert.equal(formatInr(106.904), "₹106.90");
  });

  test("a negative puts the minus after the symbol, which is why signedInr exists", () => {
    // Pinned deliberately: "₹-350.00" is the wrong shape, and this is the
    // reason every caller that can go negative wraps it in signedInr() to get
    // "−₹350.00". If this ever changes, that wrapper needs revisiting.
    assert.equal(formatInr(-350), "₹-350.00");
  });
});

describe("age in IST calendar days", () => {
  const noon = (iso: string) => Date.parse(iso);

  test("something from earlier today is today, not 0 days of prose", () => {
    assert.equal(istAgeInDays("2026-09-15T03:00:00.000Z", noon("2026-09-15T09:00:00.000Z")), 0);
    assert.equal(formatAge(0), "today");
  });

  test("late last night is a day old this morning", () => {
    // 23:30 IST on the 14th is 18:00Z; 09:00 IST on the 15th is 03:30Z. Ten
    // hours apart, but a different calendar day - which is what a reader means.
    assert.equal(istAgeInDays("2026-09-14T18:00:00.000Z", noon("2026-09-15T03:30:00.000Z")), 1);
  });

  test("an instant just before IST midnight is not counted a day early", () => {
    // 18:25Z is 23:55 IST on the 14th - still the 14th.
    assert.equal(istAgeInDays("2026-09-14T18:25:00.000Z", noon("2026-09-14T18:29:00.000Z")), 0);
  });

  test("counts whole calendar days across a longer gap", () => {
    assert.equal(istAgeInDays("2026-09-03T06:00:00.000Z", noon("2026-09-15T06:00:00.000Z")), 12);
  });

  test("never goes negative for a future timestamp", () => {
    assert.equal(istAgeInDays("2026-09-20T06:00:00.000Z", noon("2026-09-15T06:00:00.000Z")), 0);
  });

  test("says nothing at all when there is no usable timestamp", () => {
    assert.equal(istAgeInDays(null), null);
    assert.equal(istAgeInDays("not a date"), null);
    assert.equal(formatAge(null), null);
    assert.equal(istDateWithAge(null), null);
    assert.equal(istDateWithAge("not a date"), null);
  });

  test("singular for one day, plural for the rest", () => {
    assert.equal(formatAge(1), "1 day");
    assert.equal(formatAge(2), "2 days");
  });

  test("renders date and age together", () => {
    assert.equal(
      istDateWithAge("2026-09-03T06:00:00.000Z", noon("2026-09-15T06:00:00.000Z")),
      "3 Sept · 12 days"
    );
  });
});
