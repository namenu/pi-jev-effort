/**
 * Turning one Jev answer into a level.
 *
 * Jev returns a distribution over the rubric, and that distribution is the
 * useful part. An expected score hides what a split answer is telling you: a
 * vague prompt like "fix this" comes back 0.47 / 0.09 / 0.43 / 0.01, whose mean
 * rounds to a middle level nothing voted for, carrying a confidence so low that
 * no gate will ever pass it. So decisions are made on cumulative mass instead —
 * the scale is ordinal, and "how much of the answer sits at or below this level"
 * is the question that actually matters.
 */

export interface Judgement {
  /** Expected score, kept for display. */
  score: number;
  /** Jev's own confidence in that score, kept for display. */
  confidence: number;
  /** Probability per rubric index, ascending. */
  probabilities: number[];
}

export const atMost = (p: number[], index: number): number =>
  p.slice(0, index + 1).reduce((a, b) => a + b, 0);

export const atLeast = (p: number[], index: number): number =>
  p.slice(index).reduce((a, b) => a + b, 0);

export const mode = (p: number[]): number =>
  p.reduce((best, v, i) => (v > p[best] ? i : best), 0);

export interface Gates {
  minUpgradeConfidence: number;
  minDowngradeConfidence: number;
}

/**
 * The rubric index to move to, or null to stay. Upgrades look for the highest
 * level that enough of the distribution reaches; downgrades look for the lowest
 * level that enough of it falls under. Upgrades are checked first: when a split
 * answer could justify both, the thinking is the cheaper mistake.
 */
export const chooseIndex = (current: number, p: number[], gates: Gates): number | null => {
  for (let i = p.length - 1; i > current; i--) {
    if (atLeast(p, i) >= gates.minUpgradeConfidence) return i;
  }
  for (let i = 0; i < current; i++) {
    if (atMost(p, i) >= gates.minDowngradeConfidence) return i;
  }
  return null;
};

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** One glyph per rubric level, so a split answer is visible at a glance. */
export const sparkline = (p: number[]): string =>
  p.map((v) => BLOCKS[Math.max(0, Math.min(7, Math.round(v * 7)))]).join("");

export const bar = (value: number, width = 10): string => {
  const filled = Math.round(value * width);
  return "█".repeat(filled) + "·".repeat(Math.max(0, width - filled));
};
