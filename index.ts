import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import {
  atLeast,
  atMost,
  bar,
  chooseIndex,
  mode,
  sparkline,
  type Judgement,
} from "./decide.ts";
import {
  humanizeReset,
  openRouterCredits,
  parseRateLimitHeaders,
  pressureCeiling,
  readSpend,
  windowBounds,
  type Budget,
  type Pressure,
  type RateLimit,
} from "./usage.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Ordered so a level can be compared against another by index. */
const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Jev speaks the same wire format on both; only the URL and the model id differ. */
export type Provider = "typesafe" | "openrouter";

const ENDPOINTS: Record<Provider, { baseUrl: string; path: string; model: string }> = {
  typesafe: { baseUrl: "https://api.typesafe.ai", path: "/v1/systemone", model: "jev-latest" },
  openrouter: {
    baseUrl: "https://openrouter.ai",
    path: "/api/alpha/decisions",
    model: "~typesafe/jev-latest",
  },
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "jev-effort.json");
const STATUS_KEY = "jev-effort";
const HISTORY = 10;

export interface Config {
  enabled: boolean;
  /** "auto" prefers a TypeSafe key and falls back to the OpenRouter key pi already holds. */
  provider: "auto" | Provider;
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
  timeoutMs: number;
  /** Rubric index -> thinking level. */
  levels: ThinkingLevel[];
  /** Share of the distribution that must reach a level before moving up to it. */
  minUpgradeConfidence: number;
  /** Share of the distribution that must fall under a level before moving down to it. */
  minDowngradeConfidence: number;
  floor: ThinkingLevel | null;
  ceiling: ThinkingLevel | null;
  /** Skip prompts shorter than this; 0 judges everything, which is the default. */
  minPromptChars: number;
  budget: BudgetConfig;
  notify: boolean;
  debug: boolean;
}

export interface BudgetConfig {
  /** "auto" takes provider headers, then the OpenRouter balance, then a local budget. */
  source: "auto" | "headers" | "openrouter" | "local" | "none";
  /** Rolling block used for the burn rate, and for the local budget window. */
  windowHours: number;
  /** Dollars allowed per window; only the "local" source needs it. */
  limitUsd: number | null;
  /** Ceilings applied once the remaining fraction drops below each threshold. */
  pressure: Pressure[];
  /** How long a balance lookup is reused before it is refetched. */
  refreshMs: number;
}

export const DEFAULTS: Config = {
  enabled: true,
  provider: "auto",
  apiKey: null,
  baseUrl: null,
  model: null,
  timeoutMs: 4000,
  levels: ["minimal", "low", "medium", "high"],
  // Asymmetric on purpose: spending more thinking than needed costs tokens,
  // spending less costs a wrong answer, so upgrades clear a lower bar.
  minUpgradeConfidence: 0.3,
  minDowngradeConfidence: 0.6,
  floor: null,
  ceiling: null,
  minPromptChars: 0,
  budget: {
    source: "auto",
    windowHours: 5,
    limitUsd: null,
    pressure: [
      { remainingBelow: 0.3, ceiling: "medium" },
      { remainingBelow: 0.1, ceiling: "low" },
    ],
    refreshMs: 60_000,
  },
  notify: false,
  debug: false,
};

/** Indexed from zero; the index is the effort score Jev returns. */
const RUBRIC = [
  "Trivial or mechanical. A greeting, a short factual question, reading or listing files, " +
    "a rename, a one-line edit whose answer is already in view.",
  "Routine. A small well-specified change in one or two files, a bug with a clear repro, " +
    "writing a short test, following a pattern that already exists in the codebase.",
  "Substantial. Changes spanning several files, unfamiliar code that has to be traced first, " +
    "an ambiguous failure, designing a small API, tradeoffs that are not obvious.",
  "Hard. Architecture, migration or concurrency work, a subtle performance or correctness bug, " +
    "conflicting constraints, work that needs a plan and verification before it can be trusted.",
] as const;

const RUBRIC_LABELS = ["trivial", "routine", "substantial", "hard"] as const;

const INSTRUCTIONS =
  "A developer sent this prompt to a coding agent. How much step-by-step reasoning does " +
  "answering it well require? Judge the work the prompt asks for, not how politely it is " +
  "written and not how long it is. A short prompt continuing earlier work asks for as much " +
  "as the work it continues.";

export const rankOf = (level: string): number => {
  const i = LEVELS.indexOf(level as ThinkingLevel);
  return i === -1 ? 0 : i;
};

const clampLevel = (
  level: ThinkingLevel,
  floor: ThinkingLevel | null,
  ceiling: ThinkingLevel | null,
): ThinkingLevel => {
  let rank = rankOf(level);
  if (floor) rank = Math.max(rank, rankOf(floor));
  if (ceiling) rank = Math.min(rank, rankOf(ceiling));
  return LEVELS[rank];
};

/** Where the current level sits on the rubric: exact match, else nearest rank. */
export const indexOfLevel = (level: ThinkingLevel, levels: ThinkingLevel[]): number => {
  const exact = levels.indexOf(level);
  if (exact !== -1) return exact;
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  levels.forEach((candidate, i) => {
    const d = Math.abs(rankOf(candidate) - rankOf(level));
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
};

/**
 * The level to switch to, or null to stay put. The distribution decides the
 * direction and has to clear its threshold; the ceiling is a hard cap that does
 * not, because a budget that has run out is not an opinion.
 */
export const plan = (
  current: ThinkingLevel,
  judgement: Judgement,
  cfg: Config,
  ceiling: ThinkingLevel | null,
): ThinkingLevel | null => {
  const currentIndex = indexOfLevel(current, cfg.levels);
  const target = chooseIndex(currentIndex, judgement.probabilities, cfg);
  const proposed = target === null ? current : cfg.levels[target];
  const capped = clampLevel(proposed, cfg.floor, ceiling);
  return capped === current ? null : capped;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  let fromFile: Partial<Config> = {};
  try {
    fromFile = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  } catch {
    // No config file is the normal case; a malformed one falls back to defaults.
  }
  const cfg = { ...DEFAULTS, ...fromFile, budget: { ...DEFAULTS.budget, ...fromFile.budget } };
  if (env.JEV_EFFORT_DEBUG) cfg.debug = true;
  return cfg;
};

/** jev-cli and the other Jev tools keep the key here; reuse it rather than ask twice. */
const jevConfigKey = (): string | null => {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".jev", "config.json"), "utf8"));
    return typeof raw?.apiKey === "string" ? raw.apiKey : null;
  } catch {
    return null;
  }
};

export interface Route {
  provider: Provider;
  url: string;
  apiKey: string;
  model: string;
}

export const buildRoute = (provider: Provider, apiKey: string, cfg: Config): Route => {
  const e = ENDPOINTS[provider];
  return {
    provider,
    apiKey,
    model: cfg.model ?? e.model,
    url: `${cfg.baseUrl ?? e.baseUrl}${e.path}`,
  };
};

export const classify = async (
  state: Record<string, unknown>,
  route: Route,
  cfg: Config,
): Promise<Judgement | null> => {
  const res = await fetch(route.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${route.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: route.model,
      state,
      questions: {
        effort: { type: "score", instructions: INSTRUCTIONS, criteria: RUBRIC },
      },
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${route.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    answers?: {
      effort?: { score?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> };
    };
  };
  const answer = body.answers?.effort;
  if (typeof answer?.score !== "number" || typeof answer.confidence !== "number") return null;
  const probabilities = RUBRIC.map((_, i) => {
    const v = answer.probabilities?.[String(i)];
    return typeof v === "number" ? v : 0;
  });
  if (probabilities.every((v) => v === 0)) return null;
  return { score: answer.score, confidence: answer.confidence, probabilities };
};

interface Recorded extends Judgement {
  at: number;
  prompt: string;
  from: ThinkingLevel;
  to: ThinkingLevel;
}

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  let paused = false;
  let lastApplied: ThinkingLevel | null = null;
  let lastRoute: Route | null = null;
  let lastBudget: Budget | null = null;
  let observedLimit: RateLimit | null = null;
  let balance: { at: number; remainingFraction: number } | null = null;
  const history: Recorded[] = [];
  // Context for a follow-up too short to judge on its own.
  let previousReply: string | null = null;
  let previousTools: string[] = [];
  // Set while we call setThinkingLevel so the resulting event is not read as a
  // manual override. Model changes clamp the level too, hence the timestamp.
  let applying = false;
  let levelChurnUntil = 0;

  const log = (msg: string) => {
    if (cfg.debug) process.stderr.write(`[jev-effort] ${msg}\n`);
  };

  /**
   * Resolved per turn rather than cached: pi refreshes the OpenRouter OAuth
   * token in the background, and a stale copy would fail the rest of the session.
   */
  const resolveRoute = async (ctx: ExtensionContext): Promise<Route | null> => {
    if (cfg.provider !== "openrouter") {
      const key = cfg.apiKey ?? process.env.TYPESAFE_API_KEY ?? jevConfigKey();
      if (key) return buildRoute("typesafe", key, cfg);
      if (cfg.provider === "typesafe") return null;
    }
    const key =
      (cfg.provider === "openrouter" ? cfg.apiKey : null) ??
      process.env.OPENROUTER_API_KEY ??
      (await ctx.modelRegistry.getApiKeyForProvider("openrouter")) ??
      null;
    return key ? buildRoute("openrouter", key, cfg) : null;
  };

  /**
   * Remaining quota, how fast it is going, and when it returns. The spend half
   * is always local; only the ceiling half needs the provider to say anything.
   */
  const resolveBudget = async (route: Route | null): Promise<Budget> => {
    const b = cfg.budget;
    const { start, end } = windowBounds(b.windowHours);
    const spend = readSpend(start);
    const none: Budget = {
      source: "none",
      remainingFraction: null,
      resetAt: null,
      spend,
      exhaustsBeforeReset: false,
    };
    if (b.source === "none") return none;

    if (b.source === "auto" || b.source === "headers") {
      const l = observedLimit;
      if (l?.limit && l.remaining !== undefined) {
        return {
          source: "headers",
          remainingFraction: Math.max(0, Math.min(1, l.remaining / l.limit)),
          resetAt: l.resetAt ?? null,
          spend,
          exhaustsBeforeReset: false,
        };
      }
      if (b.source === "headers") return none;
    }

    if ((b.source === "auto" || b.source === "openrouter") && route?.provider === "openrouter") {
      const fresh = balance && Date.now() - balance.at < b.refreshMs;
      if (!fresh) {
        try {
          const credits = await openRouterCredits(route.apiKey, cfg.timeoutMs);
          balance = credits
            ? { at: Date.now(), remainingFraction: credits.remainingFraction }
            : null;
        } catch {
          // A balance lookup is advisory; losing it must not change the turn.
        }
      }
      if (balance) {
        return {
          source: "openrouter",
          remainingFraction: balance.remainingFraction,
          // Purchased credits do not come back on a schedule.
          resetAt: null,
          spend,
          exhaustsBeforeReset: false,
        };
      }
      if (b.source === "openrouter") return none;
    }

    if ((b.source === "auto" || b.source === "local") && b.limitUsd) {
      const remainingUsd = Math.max(0, b.limitUsd - spend.usd);
      const minutesLeft = (end - Date.now()) / 60000;
      return {
        source: "local",
        remainingFraction: Math.min(1, remainingUsd / b.limitUsd),
        resetAt: end,
        spend,
        exhaustsBeforeReset:
          spend.burnUsdPerMin > 0 && remainingUsd / spend.burnUsdPerMin < minutesLeft,
      };
    }
    return none;
  };

  /** The tighter of the configured ceiling and the one budget pressure forces. */
  const effectiveCeiling = (budget: Budget): ThinkingLevel | null => {
    const forced = pressureCeiling(budget, cfg.budget.pressure) as ThinkingLevel | null;
    if (!forced) return cfg.ceiling;
    if (!cfg.ceiling) return forced;
    return rankOf(forced) < rankOf(cfg.ceiling) ? forced : cfg.ceiling;
  };

  const status = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!cfg.enabled || paused) {
      ctx.ui.setStatus(STATUS_KEY, paused ? "jev paused" : undefined);
      return;
    }
    const last = history[0];
    const level = pi.getThinkingLevel() as ThinkingLevel;
    let head = "jev auto";
    if (last) {
      // A tilde marks a level the judgement leans away from but could not move:
      // the distribution pointed elsewhere without clearing its threshold.
      const leaning = cfg.levels[mode(last.probabilities)];
      const held = leaning !== level ? "~" : "";
      head = `jev ${sparkline(last.probabilities)} ${held}${level}`;
    }
    const parts = [head];
    const b = lastBudget;
    if (b && b.remainingFraction !== null) parts.push(`${Math.round(b.remainingFraction * 100)}%`);
    const reset = humanizeReset(b?.resetAt ?? null);
    if (reset) parts.push(`resets ${reset}`);
    ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
  };

  const readout = (): string => {
    const last = history[0];
    const level = pi.getThinkingLevel();
    const state = !cfg.enabled ? "off" : paused ? "paused" : "on";
    const lines = [
      `jev-effort ${state} · via ${lastRoute?.provider ?? "unresolved"} · level ${level}`,
    ];
    if (last) {
      lines.push(`last: ${JSON.stringify(last.prompt.slice(0, 60))} → ${last.from} → ${last.to}`);
      last.probabilities.forEach((v, i) => {
        const label = (RUBRIC_LABELS[i] ?? String(i)).padEnd(11);
        const level = (cfg.levels[i] ?? "?").padEnd(7);
        lines.push(`  ${i} ${label} ${level} ${bar(v)} ${v.toFixed(2)}`);
      });
      lines.push(
        `  score ${last.score.toFixed(2)} · confidence ${last.confidence.toFixed(2)} · ` +
          `P(≤${mode(last.probabilities)})=${atMost(last.probabilities, mode(last.probabilities)).toFixed(2)}`,
      );
    } else {
      lines.push("no judgement yet in this session");
    }
    const b = lastBudget;
    if (b) {
      const left = b.remainingFraction === null ? "?" : `${Math.round(b.remainingFraction * 100)}%`;
      const reset = humanizeReset(b.resetAt);
      lines.push(
        `budget ${b.source} ${left}${reset ? ` (resets ${reset})` : ""} · ` +
          `${b.spend.tokens.toLocaleString()} tok / $${b.spend.usd.toFixed(3)} in ` +
          `${cfg.budget.windowHours}h · $${b.spend.burnUsdPerMin.toFixed(5)}/min`,
      );
    }
    return lines.join("\n");
  };

  pi.on("session_start", async (_event, ctx) => {
    levelChurnUntil = Date.now() + 2000;
    history.length = 0;
    previousReply = null;
    previousTools = [];
    if (cfg.enabled) {
      const route = await resolveRoute(ctx);
      if (!route) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "jev-effort: no key. Set TYPESAFE_API_KEY, or sign in to OpenRouter in pi.",
            "warning",
          );
          ctx.ui.setStatus(STATUS_KEY, "jev no key");
        }
        return;
      }
      log(`route ${route.provider} ${route.url} model=${route.model}`);
    }
    status(ctx);
  });

  pi.on("after_provider_response", async (event, _ctx) => {
    // Free of charge: whatever the provider already said about its own limits.
    const seen = parseRateLimitHeaders(event.headers ?? {});
    if (seen) observedLimit = { ...observedLimit, ...seen };
  });

  pi.on("turn_end", async (event, _ctx) => {
    // Remembered so the next prompt, however short, can be judged in context.
    const content = (event.message as { content?: unknown } | undefined)?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : ""))
            .join(" ")
        : "";
    previousReply = text.trim().slice(0, 300) || previousReply;
    const results = (event.toolResults ?? []) as { toolName?: string }[];
    if (results.length) {
      previousTools = [...new Set(results.map((r) => r.toolName ?? "").filter(Boolean))];
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    // A model change can clamp the thinking level; that is not the user typing /effort.
    levelChurnUntil = Date.now() + 1000;
    status(ctx);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    log(`level -> ${event.level} (applying=${applying})`);
    if (applying || Date.now() < levelChurnUntil) return;
    if (event.level === lastApplied) return;
    if (cfg.enabled && !paused) {
      paused = true;
      if (ctx.hasUI) {
        ctx.ui.notify(`jev-effort: manual ${event.level}, auto paused. /jev-effort on`, "info");
      }
    }
    status(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!cfg.enabled || paused) return;
    const prompt = (event.prompt ?? "").trim();
    if (prompt.length < Math.max(1, cfg.minPromptChars)) return;

    const current = pi.getThinkingLevel() as ThinkingLevel;
    let judgement: Judgement | null = null;
    try {
      const route = await resolveRoute(ctx);
      if (!route) return;
      lastRoute = route;
      judgement = await classify(
        {
          prompt,
          project: basename(ctx.cwd),
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
          current_thinking_level: current,
          continuing_work: previousReply !== null,
          previous_reply: previousReply,
          previous_tools: previousTools.length ? previousTools : null,
        },
        route,
        cfg,
      );
    } catch (err) {
      // Fail open: a judgement layer must never cost the user their turn.
      log(`classify failed: ${String(err)}`);
      return;
    }
    if (!judgement) return;

    const budget = await resolveBudget(lastRoute);
    lastBudget = budget;
    const ceiling = effectiveCeiling(budget);
    const next = plan(current, judgement, cfg, ceiling);
    const p = judgement.probabilities;
    const left =
      budget.remainingFraction === null ? "n/a" : `${Math.round(budget.remainingFraction * 100)}%`;
    log(
      `${sparkline(p)} score=${judgement.score.toFixed(2)} conf=${judgement.confidence.toFixed(2)} ` +
        `P(<=${indexOfLevel(current, cfg.levels)})=${atMost(p, indexOfLevel(current, cfg.levels)).toFixed(2)} ` +
        `P(>=${indexOfLevel(current, cfg.levels)})=${atLeast(p, indexOfLevel(current, cfg.levels)).toFixed(2)} ` +
        `budget=${budget.source}:${left} ceiling=${ceiling ?? "none"} ${current} -> ${next ?? current}`,
    );
    if (next) {
      applying = true;
      try {
        pi.setThinkingLevel(next);
      } finally {
        applying = false;
      }
      // Pi clamps to what the model supports, so record what actually took effect.
      lastApplied = pi.getThinkingLevel() as ThinkingLevel;
      if (cfg.notify && ctx.hasUI) ctx.ui.notify(`jev-effort: ${current} → ${next}`, "info");
    }
    history.unshift({
      ...judgement,
      at: Date.now(),
      prompt,
      from: current,
      to: (next ?? current) as ThinkingLevel,
    });
    history.length = Math.min(history.length, HISTORY);
    status(ctx);
  });

  pi.registerCommand("jev-effort", {
    description: "Jev-driven thinking level: status | on | off | last",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") {
        cfg.enabled = true;
        paused = false;
      } else if (arg === "off") {
        cfg.enabled = false;
      } else if (arg === "last") {
        const lines = history.length
          ? history.map((h) => {
              const moved = h.from === h.to ? `${h.to} held` : `${h.from} → ${h.to}`;
              return `${sparkline(h.probabilities)} ${h.score.toFixed(2)} ${moved}  ${h.prompt.slice(0, 40)}`;
            })
          : ["no judgements yet in this session"];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      } else if (arg && arg !== "status") {
        ctx.ui.notify("jev-effort: usage /jev-effort [status|on|off|last]", "warning");
        return;
      }
      if (!lastBudget) lastBudget = await resolveBudget(lastRoute);
      ctx.ui.notify(readout(), "info");
      status(ctx);
    },
  });
}
