import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULTS, buildRoute, classify, indexOfLevel, plan, type Config } from "./index.ts";
import { atLeast, atMost, chooseIndex, mode, sparkline, type Judgement } from "./decide.ts";

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULTS, ...over });
const route = (c: Config = cfg()) => buildRoute("typesafe", "test-key", c);
const judgement = (probabilities: number[]): Judgement => ({
  probabilities,
  score: probabilities.reduce((a, v, i) => a + v * i, 0),
  confidence: Math.max(...probabilities),
});

// The distribution a vague prompt like "fix this" actually produced.
const SPLIT = [0.47, 0.09, 0.43, 0.01];
// What a greeting produces.
const TRIVIAL = [1, 0, 0, 0];

test("a split answer steps down one level instead of landing in its own mean", () => {
  // Rounding the mean (0.96) would pick "low" on a distribution whose mass sits
  // at trivial and substantial. Cumulative mass moves one step down from high.
  assert.equal(plan("high", judgement(SPLIT), cfg(), null), "medium");
  // From medium neither tail clears its bar, so the level stands.
  assert.equal(plan("medium", judgement(SPLIT), cfg(), null), null);
  // From low, enough mass reaches "substantial" to justify medium.
  assert.equal(plan("low", judgement(SPLIT), cfg(), null), "medium");
});

test("a decisive answer moves even from far away", () => {
  assert.equal(plan("medium", judgement(TRIVIAL), cfg(), null), "minimal");
  assert.equal(plan("minimal", judgement([0, 0, 0.1, 0.9]), cfg(), null), "high");
});

test("upgrades clear a lower bar than downgrades", () => {
  const gates = { minUpgradeConfidence: 0.3, minDowngradeConfidence: 0.6 };
  // 0.35 of the mass reaches index 2: enough to go up, from index 1.
  assert.equal(chooseIndex(1, [0.5, 0.15, 0.3, 0.05], gates), 2);
  // The same 0.5 sitting under index 0 is not enough to come down to it.
  assert.equal(chooseIndex(1, [0.5, 0.5, 0, 0], gates), null);
  // 0.65 under index 0 is.
  assert.equal(chooseIndex(2, [0.65, 0.1, 0.2, 0.05], gates), 0);
});

test("a ceiling caps the level even when the distribution cannot move it", () => {
  // Observed live: budget pressure forced "low" while the judgement held.
  assert.equal(plan("high", judgement(SPLIT), cfg(), "low"), "low");
  assert.equal(plan("minimal", judgement([0, 0, 0, 1]), cfg(), "medium"), "medium");
});

test("cumulative mass, mode and sparkline read the distribution", () => {
  assert.equal(atMost(SPLIT, 1).toFixed(2), "0.56");
  assert.equal(atLeast(SPLIT, 2).toFixed(2), "0.44");
  assert.equal(mode(SPLIT), 0);
  assert.equal(sparkline([0, 0.5, 1, 0]).length, 4);
  assert.equal(sparkline([0, 0, 1, 0]), "▁▁█▁");
});

test("a level outside the rubric maps to the nearest rung", () => {
  const levels = DEFAULTS.levels;
  assert.equal(indexOfLevel("medium", levels), 2);
  // "xhigh" is not in the default mapping; the nearest is "high".
  assert.equal(indexOfLevel("xhigh", levels), 3);
  assert.equal(indexOfLevel("off", levels), 0);
});

test("each provider gets its own endpoint and model id", () => {
  assert.deepEqual(buildRoute("typesafe", "k", cfg()), {
    provider: "typesafe",
    apiKey: "k",
    model: "jev-latest",
    url: "https://api.typesafe.ai/v1/systemone",
  });
  assert.deepEqual(buildRoute("openrouter", "k", cfg()), {
    provider: "openrouter",
    apiKey: "k",
    model: "~typesafe/jev-latest",
    url: "https://openrouter.ai/api/alpha/decisions",
  });
  const over = buildRoute(
    "openrouter",
    "k",
    cfg({ baseUrl: "http://127.0.0.1:8799", model: "jev-1.13" }),
  );
  assert.equal(over.url, "http://127.0.0.1:8799/api/alpha/decisions");
  assert.equal(over.model, "jev-1.13");
});

test("classify keeps the distribution, and rejects an answer without one", async (t) => {
  const c = cfg();
  const bodies: unknown[] = [
    {
      answers: {
        effort: {
          type: "score",
          score: 2.3,
          confidence: 0.71,
          probabilities: { "0": 0.05, "1": 0.1, "2": 0.55, "3": 0.3 },
        },
      },
    },
    { answers: { effort: { type: "score", score: 2.3, confidence: 0.71 } } },
    { answers: {} },
  ];
  let sent: { url: string; init: RequestInit } | null = null;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response(JSON.stringify(bodies.shift()), { status: 200 });
  });

  const first = await classify({ prompt: "x" }, route(c), c);
  assert.deepEqual(first?.probabilities, [0.05, 0.1, 0.55, 0.3]);
  assert.equal(sent!.url, "https://api.typesafe.ai/v1/systemone");
  const body = JSON.parse(sent!.init.body as string);
  assert.equal(body.questions.effort.criteria.length, c.levels.length);

  // An answer with no probabilities cannot be acted on.
  assert.equal(await classify({ prompt: "x" }, route(c), c), null);
  assert.equal(await classify({ prompt: "x" }, route(c), c), null);
});

test("an API error carries the provider and body so the caller can fail open", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("guardrail", { status: 404 }));
  await assert.rejects(
    () => classify({ prompt: "x" }, buildRoute("openrouter", "k", cfg()), cfg()),
    /openrouter 404: guardrail/,
  );
});
