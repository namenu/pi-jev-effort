import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  humanizeReset,
  parseRateLimitHeaders,
  pressureCeiling,
  readSpend,
  windowBounds,
  type Budget,
} from "./usage.ts";

const msg = (at: number, usd: number, tokens: number) =>
  JSON.stringify({
    type: "message",
    timestamp: new Date(at).toISOString(),
    message: { role: "assistant", usage: { totalTokens: tokens, cost: { total: usd } } },
  });

test("spend counts assistant usage inside the window and derives a burn rate", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-usage-"));
  mkdirSync(join(dir, "proj"));
  const now = Date.now();
  writeFileSync(
    join(dir, "proj", "a.jsonl"),
    [
      JSON.stringify({ type: "session", timestamp: new Date(now).toISOString() }),
      msg(now - 40 * 60000, 0.5, 1000),
      msg(now - 20 * 60000, 0.25, 500),
      "{ half written",
    ].join("\n"),
  );
  const spend = readSpend(now - 60 * 60000, dir);
  assert.equal(spend.usd, 0.75);
  assert.equal(spend.tokens, 1500);
  // $0.75 across the 20 minutes between the two messages.
  assert.ok(Math.abs(spend.burnUsdPerMin - 0.0375) < 1e-9);
});

test("spend ignores rows older than the window", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-usage-"));
  mkdirSync(join(dir, "proj"));
  const now = Date.now();
  writeFileSync(join(dir, "proj", "a.jsonl"), [msg(now - 10 * 60000, 1, 10)].join("\n"));
  assert.equal(readSpend(now - 5 * 60000, dir).usd, 0);
});

test("rate limit headers are read in each shape a provider may send", () => {
  const now = Date.now();
  const epochSeconds = parseRateLimitHeaders({
    "x-ratelimit-limit": "100",
    "x-ratelimit-remaining": "25",
    "x-ratelimit-reset": String(Math.floor((now + 600_000) / 1000)),
  });
  assert.equal(epochSeconds?.remaining, 25);
  assert.ok(Math.abs(epochSeconds!.resetAt! - (now + 600_000)) < 2000);

  const relative = parseRateLimitHeaders({ "x-ratelimit-reset": "120" });
  assert.ok(Math.abs(relative!.resetAt! - (now + 120_000)) < 2000);

  const retry = parseRateLimitHeaders({ "retry-after": "30" });
  assert.ok(Math.abs(retry!.resetAt! - (now + 30_000)) < 2000);

  assert.equal(parseRateLimitHeaders({ "content-type": "application/json" }), null);
});

const budget = (over: Partial<Budget> = {}): Budget => ({
  source: "local",
  remainingFraction: 1,
  resetAt: null,
  spend: { usd: 0, tokens: 0, since: 0, burnUsdPerMin: 0 },
  exhaustsBeforeReset: false,
  ...over,
});

test("pressure picks the lowest ceiling crossed, and one more when the burn empties it early", () => {
  const rules = [
    { remainingBelow: 0.3, ceiling: "medium" },
    { remainingBelow: 0.1, ceiling: "low" },
  ];
  assert.equal(pressureCeiling(budget({ remainingFraction: 0.5 }), rules), null);
  assert.equal(pressureCeiling(budget({ remainingFraction: 0.2 }), rules), "medium");
  assert.equal(pressureCeiling(budget({ remainingFraction: 0.05 }), rules), "low");
  assert.equal(
    pressureCeiling(budget({ remainingFraction: 0.2, exhaustsBeforeReset: true }), rules),
    "low",
  );
  assert.equal(pressureCeiling(budget({ remainingFraction: null }), rules), null);
});

test("windows sit on a UTC grid and resets read as human time", () => {
  const { start, end } = windowBounds(5, Date.parse("2026-09-21T03:30:00Z"));
  assert.equal(new Date(start).toISOString(), "2026-09-21T02:00:00.000Z");
  assert.equal(new Date(end).toISOString(), "2026-09-21T07:00:00.000Z");
  const now = Date.now();
  assert.equal(humanizeReset(now + 131 * 60000, now), "2h11m");
  assert.equal(humanizeReset(now + 5 * 60000, now), "5m");
  assert.equal(humanizeReset(null, now), "");
});
