import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULTS, buildRoute, classify, decide, plan, type Config } from "./index.ts";

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULTS, ...over });
const route = (c: Config = cfg()) => buildRoute("typesafe", "test-key", c);

test("an upgrade clears the lower confidence bar, a downgrade does not", () => {
  const c = cfg();
  assert.equal(decide("low", 2.4, 0.35, c), "medium");
  assert.equal(decide("high", 0.2, 0.4, c), null);
  assert.equal(decide("high", 0.2, 0.7, c), "minimal");
});

test("a score that maps to the level already in effect changes nothing", () => {
  assert.equal(decide("medium", 1.8, 0.99, cfg()), null);
});

test("floor and ceiling clamp the target level", () => {
  assert.equal(decide("low", 3, 0.9, cfg({ ceiling: "medium" })), "medium");
  assert.equal(decide("medium", 0, 0.9, cfg({ floor: "low" })), "low");
});

test("a ceiling caps the level even when the judgement is not confident enough to move", () => {
  // Observed live: budget pressure forced "low" while Jev scored 2.38 at 0.55
  // confidence, which is under the downgrade bar. The cap has to win anyway.
  assert.equal(plan("high", 2.38, 0.55, cfg(), "low"), "low");
  // With no pressure the same judgement leaves the level alone.
  assert.equal(plan("high", 2.38, 0.55, cfg(), null), null);
  // An upgrade past the cap lands on the cap.
  assert.equal(plan("minimal", 3, 0.9, cfg(), "medium"), "medium");
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
  const over = buildRoute("openrouter", "k", cfg({ baseUrl: "http://127.0.0.1:8799", model: "jev-1.13" }));
  assert.equal(over.url, "http://127.0.0.1:8799/api/alpha/decisions");
  assert.equal(over.model, "jev-1.13");
});

test("classify reads score and confidence, and rejects a malformed answer", async (t) => {
  const c = cfg();
  const bodies: unknown[] = [
    { model: "jev-latest", answers: { effort: { type: "score", score: 2.3, confidence: 0.71 } } },
    { model: "jev-latest", answers: {} },
  ];
  let sent: { url: string; init: RequestInit } | null = null;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response(JSON.stringify(bodies.shift()), { status: 200 });
  });

  assert.deepEqual(await classify({ prompt: "x" }, route(c), c), { score: 2.3, confidence: 0.71 });
  assert.equal(sent!.url, "https://api.typesafe.ai/v1/systemone");
  const body = JSON.parse(sent!.init.body as string);
  assert.equal(body.model, "jev-latest");
  assert.equal(body.questions.effort.type, "score");
  assert.equal(body.questions.effort.criteria.length, c.levels.length);

  assert.equal(await classify({ prompt: "x" }, route(c), c), null);
});

test("an API error carries the provider and body so the caller can fail open", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("guardrail", { status: 404 }));
  await assert.rejects(
    () => classify({ prompt: "x" }, buildRoute("openrouter", "k", cfg()), cfg()),
    /openrouter 404: guardrail/,
  );
});
