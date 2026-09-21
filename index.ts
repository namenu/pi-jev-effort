import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
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
  minUpgradeConfidence: number;
  minDowngradeConfidence: number;
  floor: ThinkingLevel | null;
  ceiling: ThinkingLevel | null;
  /** Prompts shorter than this keep the current level without a Jev call. */
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
  timeoutMs: 2500,
  levels: ["minimal", "low", "medium", "high"],
  // Asymmetric on purpose: spending more thinking than needed costs tokens,
  // spending less costs a wrong answer, so upgrades clear a lower bar.
  minUpgradeConfidence: 0.3,
  minDowngradeConfidence: 0.6,
  floor: null,
  ceiling: null,
  minPromptChars: 12,
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

const INSTRUCTIONS =
  "A developer sent this prompt to a coding agent. How much step-by-step reasoning does " +
  "answering it well require? Judge the work the prompt asks for, not how politely it is " +
  "written and not how long it is.";

export const rankOf = (level: string): number => {
  const i = LEVELS.indexOf(level as ThinkingLevel);
  return i === -1 ? 0 : i;
};

const clampLevel = (level: ThinkingLevel, cfg: Config): ThinkingLevel => {
  let rank = rankOf(level);
  if (cfg.floor) rank = Math.max(rank, rankOf(cfg.floor));
  if (cfg.ceiling) rank = Math.min(rank, rankOf(cfg.ceiling));
  return LEVELS[rank];
};

/**
 * Map an expected score onto a level, then apply hysteresis against the level
 * already in effect. Returns null when the current level should stand.
 */
export const decide = (
  current: ThinkingLevel,
  score: number,
  confidence: number,
  cfg: Config,
): ThinkingLevel | null => {
  const index = Math.min(cfg.levels.length - 1, Math.max(0, Math.round(score)));
  const target = clampLevel(cfg.levels[index], cfg);
  const delta = rankOf(target) - rankOf(current);
  if (delta === 0) return null;
  const needed = delta > 0 ? cfg.minUpgradeConfidence : cfg.minDowngradeConfidence;
  return confidence >= needed ? target : null;
};

/**
 * The level to switch to, or null to stay put. The judgement decides direction
 * and has to clear its confidence bar; the ceiling is a hard cap that does not,
 * because a budget that has run out is not an opinion.
 */
export const plan = (
  current: ThinkingLevel,
  score: number,
  confidence: number,
  cfg: Config,
  ceiling: ThinkingLevel | null,
): ThinkingLevel | null => {
  const proposed = decide(current, score, confidence, { ...cfg, ceiling: null }) ?? current;
  const capped = clampLevel(proposed, { ...cfg, ceiling });
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

export interface Judgement {
  score: number;
  confidence: number;
}

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
    answers?: { effort?: { score?: unknown; confidence?: unknown } };
  };
  const { score, confidence } = body.answers?.effort ?? {};
  if (typeof score !== "number" || typeof confidence !== "number") return null;
  return { score, confidence };
};

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  let paused = false;
  let lastApplied: ThinkingLevel | null = null;
  let lastJudgement: Judgement | null = null;
  let lastRoute: Route | null = null;
  let lastBudget: Budget | null = null;
  let observedLimit: RateLimit | null = null;
  let balance: { at: number; remainingFraction: number } | null = null;
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
        const fraction = Math.max(0, Math.min(1, l.remaining / l.limit));
        return {
          source: "headers",
          remainingFraction: fraction,
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
          balance = credits ? { at: Date.now(), remainingFraction: credits.remainingFraction } : null;
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
      ctx.ui.setStatus(STATUS_KEY, paused ? "jev: paused" : undefined);
      return;
    }
    const j = lastJudgement;
    const b = lastBudget;
    const parts = [j ? `jev: ${pi.getThinkingLevel()} (${j.confidence.toFixed(2)})` : "jev: auto"];
    if (b?.remainingFraction !== null && b !== null) {
      parts.push(`${Math.round(b.remainingFraction! * 100)}%`);
    }
    const reset = humanizeReset(b?.resetAt ?? null);
    if (reset) parts.push(`resets ${reset}`);
    ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
  };

  pi.on("session_start", async (_event, ctx) => {
    levelChurnUntil = Date.now() + 2000;
    if (cfg.enabled) {
      const route = await resolveRoute(ctx);
      if (!route) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "jev-effort: no key. Set TYPESAFE_API_KEY, or sign in to OpenRouter in pi.",
            "warning",
          );
          ctx.ui.setStatus(STATUS_KEY, "jev: no key");
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
    // Short follow-ups ("continue", "yes") carry no signal of their own; classifying
    // them would drag the level back down in the middle of hard work.
    if (prompt.length < cfg.minPromptChars) return;

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
    lastJudgement = judgement;

    const budget = await resolveBudget(lastRoute);
    lastBudget = budget;
    const ceiling = effectiveCeiling(budget);
    const next = plan(current, judgement.score, judgement.confidence, cfg, ceiling);
    const left =
      budget.remainingFraction === null
        ? "n/a"
        : `${Math.round(budget.remainingFraction * 100)}%`;
    log(
      `score=${judgement.score.toFixed(2)} conf=${judgement.confidence.toFixed(2)} ` +
        `budget=${budget.source}:${left} burn=$${budget.spend.burnUsdPerMin.toFixed(5)}/min ` +
        `ceiling=${ceiling ?? "none"} ${current} -> ${next ?? current}`,
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
      if (cfg.notify && ctx.hasUI) ctx.ui.notify(`jev-effort: ${current} -> ${next}`, "info");
    }
    status(ctx);
  });

  pi.registerCommand("jev-effort", {
    description: "Jev-driven automatic thinking level: on | off | status",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") {
        cfg.enabled = true;
        paused = false;
      } else if (arg === "off") {
        cfg.enabled = false;
      } else if (arg && arg !== "status") {
        ctx.ui.notify("jev-effort: usage /jev-effort [on|off|status]", "warning");
        return;
      }
      const state = !cfg.enabled ? "off" : paused ? "paused" : "on";
      const j = lastJudgement;
      const b = lastBudget ?? (await resolveBudget(lastRoute));
      lastBudget = b;
      const left = b.remainingFraction === null ? "?" : `${Math.round(b.remainingFraction * 100)}%`;
      const reset = humanizeReset(b.resetAt);
      ctx.ui.notify(
        `jev-effort ${state} · via ${lastRoute?.provider ?? "unresolved"} · ` +
          `level ${pi.getThinkingLevel()}` +
          (j ? ` · last score ${j.score.toFixed(2)} @ ${j.confidence.toFixed(2)}` : "") +
          ` · budget ${b.source} ${left}` +
          (reset ? ` (resets ${reset})` : "") +
          ` · ${b.spend.tokens.toLocaleString()} tok / $${b.spend.usd.toFixed(3)} ` +
          `in ${cfg.budget.windowHours}h`,
        "info",
      );
      status(ctx);
    },
  });
}
