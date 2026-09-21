/**
 * Budget signal: how much of the current quota is left, how fast it is going,
 * and when it comes back. Read the way ccusage and CodexBar read theirs — from
 * the local transcripts the agent already writes, plus whatever the provider
 * says about its own limits.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

export interface Spend {
  /** Dollars spent inside the window. */
  usd: number;
  tokens: number;
  /** Start of the window actually observed, as epoch ms. */
  since: number;
  /** Dollars per minute over the observed span; 0 when there is nothing to divide by. */
  burnUsdPerMin: number;
}

interface FileCache {
  size: number;
  /** [timestampMs, usd, tokens] per assistant message, ascending. */
  rows: [number, number, number][];
}

const cache = new Map<string, FileCache>();

/** Assistant messages carry `usage.cost.total`; everything else is skipped. */
const parseRows = (path: string): [number, number, number][] => {
  const rows: [number, number, number][] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line || !line.includes('"usage"')) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        timestamp?: string;
        message?: {
          usage?: { totalTokens?: number; cost?: { total?: number } };
        };
      };
      const usage = entry.message?.usage;
      const at = Date.parse(entry.timestamp ?? "");
      if (!usage || Number.isNaN(at)) continue;
      rows.push([at, usage.cost?.total ?? 0, usage.totalTokens ?? 0]);
    } catch {
      // A half-written last line is normal while a session is live.
    }
  }
  return rows;
};

/**
 * Sum what the agent spent since `since`. Files are re-read only when their
 * size changed, so a long session costs one parse per turn at most.
 */
export const readSpend = (since: number, dir = SESSIONS_DIR): Spend => {
  let usd = 0;
  let tokens = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  let projects: string[];
  try {
    projects = readdirSync(dir);
  } catch {
    return { usd: 0, tokens: 0, since, burnUsdPerMin: 0 };
  }
  for (const project of projects) {
    let files: string[];
    try {
      files = readdirSync(join(dir, project));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, project, name);
      let size: number;
      let mtimeMs: number;
      try {
        const st = statSync(path);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      // A file untouched since the window opened cannot hold rows inside it.
      if (mtimeMs < since) {
        cache.delete(path);
        continue;
      }
      let entry = cache.get(path);
      if (!entry || entry.size !== size) {
        entry = { size, rows: parseRows(path) };
        cache.set(path, entry);
      }
      for (const [at, cost, tok] of entry.rows) {
        if (at < since) continue;
        usd += cost;
        tokens += tok;
        if (at < earliest) earliest = at;
        if (at > latest) latest = at;
      }
    }
  }
  const spanMin = latest > earliest ? (latest - earliest) / 60000 : 0;
  return {
    usd,
    tokens,
    since,
    burnUsdPerMin: spanMin > 0 ? usd / spanMin : 0,
  };
};

export interface RateLimit {
  limit?: number;
  remaining?: number;
  /** Epoch ms. */
  resetAt?: number;
}

/**
 * Pull whatever a provider volunteered about its own limits. Header names
 * differ per provider and many send nothing, so every field is optional.
 */
export const parseRateLimitHeaders = (headers: Record<string, string>): RateLimit | null => {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = Number(h[k]);
      if (h[k] !== undefined && !Number.isNaN(v)) return v;
    }
    return undefined;
  };
  const limit = num("x-ratelimit-limit", "anthropic-ratelimit-unified-limit");
  const remaining = num(
    "x-ratelimit-remaining",
    "anthropic-ratelimit-unified-remaining",
    "x-ratelimit-remaining-tokens",
  );
  const rawReset = num(
    "x-ratelimit-reset",
    "anthropic-ratelimit-unified-reset",
    "x-ratelimit-reset-tokens",
  );
  const retryAfter = num("retry-after");
  let resetAt: number | undefined;
  if (rawReset !== undefined) {
    // Seconds-since-epoch, milliseconds-since-epoch and seconds-from-now all appear.
    resetAt =
      rawReset > 1e12 ? rawReset : rawReset > 1e9 ? rawReset * 1000 : Date.now() + rawReset * 1000;
  } else if (retryAfter !== undefined) {
    resetAt = Date.now() + retryAfter * 1000;
  }
  if (limit === undefined && remaining === undefined && resetAt === undefined) return null;
  return { limit, remaining, resetAt };
};

export interface Budget {
  source: "headers" | "openrouter" | "local" | "none";
  /** 0..1, or null when nothing credible says what the ceiling is. */
  remainingFraction: number | null;
  /** Epoch ms when the quota comes back, or null for a balance that does not reset. */
  resetAt: number | null;
  spend: Spend;
  /** True when the current burn rate empties the quota before it resets. */
  exhaustsBeforeReset: boolean;
}

export interface Pressure {
  remainingBelow: number;
  ceiling: string;
}

/**
 * Pick the lowest ceiling whose threshold the remaining fraction has crossed.
 * A projected exhaustion before reset counts as one threshold worse.
 */
export const pressureCeiling = (budget: Budget, rules: Pressure[]): string | null => {
  if (budget.remainingFraction === null) return null;
  const sorted = [...rules].sort((a, b) => b.remainingBelow - a.remainingBelow);
  let hit: string | null = null;
  let index = -1;
  sorted.forEach((rule, i) => {
    if (budget.remainingFraction! < rule.remainingBelow) {
      hit = rule.ceiling;
      index = i;
    }
  });
  if (budget.exhaustsBeforeReset) {
    const next = sorted[index + 1];
    if (next) return next.ceiling;
    if (!hit && sorted.length) return sorted[0].ceiling;
  }
  return hit;
};

/** OpenRouter reports purchased credits rather than a window, so this never resets. */
export const openRouterCredits = async (
  apiKey: string,
  timeoutMs: number,
): Promise<{ remainingFraction: number; remainingUsd: number } | null> => {
  const res = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { total_credits?: number; total_usage?: number } };
  const total = body.data?.total_credits;
  const used = body.data?.total_usage;
  if (typeof total !== "number" || typeof used !== "number" || total <= 0) return null;
  const remainingUsd = Math.max(0, total - used);
  return { remainingFraction: Math.min(1, remainingUsd / total), remainingUsd };
};

export const humanizeReset = (resetAt: number | null, now = Date.now()): string => {
  if (resetAt === null) return "";
  const mins = Math.max(0, Math.round((resetAt - now) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
};

/**
 * Fixed rolling blocks on a UTC grid, the way ccusage treats Claude's 5-hour
 * windows: everyone with the same window length agrees on where it starts.
 */
export const windowBounds = (
  windowHours: number,
  now = Date.now(),
): { start: number; end: number } => {
  const ms = Math.max(1, windowHours) * 3600_000;
  const start = Math.floor(now / ms) * ms;
  return { start, end: start + ms };
};
