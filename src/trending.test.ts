import { expect, test } from "bun:test";
import {
  computeTrends,
  mergeStickyTrends,
  termRegex,
  type StickyEntry,
  type Trend,
  type TrendInput,
} from "./trending";

const NOW = 1_000_000_000_000;

function c(body: string, opts: { author?: string; ageMs?: number; likes?: number; replies?: number } = {}): TrendInput {
  return {
    body,
    postedAt: new Date(NOW - (opts.ageMs ?? 10_000)).toISOString(),
    author: opts.author,
    likes: opts.likes,
    replies: opts.replies,
  };
}

/** `n` comments of the same body, each from a distinct author. */
function fromMany(body: string, n: number, ageMs = 10_000): TrendInput[] {
  return Array.from({ length: n }, (_, i) => c(body, { author: `u${i}`, ageMs }));
}

test("breadth wins: many people beat one person repeating", () => {
  const comments = [
    ...fromMany("Dougie", 3), // 3 distinct authors
    ...Array.from({ length: 6 }, () => c("Rammell", { author: "solo" })), // 1 author, 6 times
  ];
  const trends = computeTrends(comments, NOW, { minTrends: 1 });
  expect(trends[0]?.word.toLowerCase()).toBe("dougie");
});

test("engagement lifts an equally-broad term", () => {
  const trends = computeTrends(
    [
      c("apples", { author: "a" }),
      c("apples", { author: "b" }),
      c("oranges", { author: "c" }),
      c("oranges", { author: "d", likes: 20, replies: 4 }),
    ],
    NOW,
  );
  expect(trends[0]?.word.toLowerCase()).toBe("oranges");
});

test("a steady (non-surging) topic still shows", () => {
  const comments = [
    ...fromMany("migrants", 3, 30_000), // recent
    ...fromMany("migrants", 3, 300_000), // prior window (>4m, <8m)
  ];
  const trends = computeTrends(comments, NOW);
  expect(trends.some((t) => t.word.toLowerCase() === "migrants")).toBe(true);
});

test("detects a two-word phrase and suppresses its parts", () => {
  const trends = computeTrends(fromMany("Yesss Paul Cox", 3), NOW);
  const words = trends.map((t) => t.word.toLowerCase());
  expect(words).toContain("paul cox");
  expect(words).not.toContain("paul");
  expect(words).not.toContain("cox");
});

test("preserves the phrase's original casing", () => {
  const trends = computeTrends(fromMany("love Paul Cox tonight", 3), NOW);
  expect(trends.find((t) => t.word === "Paul Cox")).toBeTruthy();
});

test("does not bridge a phrase across punctuation", () => {
  const trends = computeTrends(fromMany("Yesss.... Paul is great", 3), NOW);
  expect(trends.some((t) => t.word.toLowerCase() === "yesss paul")).toBe(false);
});

test("never surfaces stopwords", () => {
  const trends = computeTrends(fromMany("they are here now", 4), NOW);
  expect(trends.every((t) => !["they", "are", "here", "now"].includes(t.word.toLowerCase()))).toBe(true);
});

test("backfills toward the minimum from single-mention terms", () => {
  const trends = computeTrends(
    [c("alpha", { author: "a" }), c("bravo", { author: "b" }), c("charlie", { author: "c" })],
    NOW,
    { minTrends: 3 },
  );
  expect(trends.length).toBe(3);
});

test("never returns more than the limit", () => {
  const words = ["nigel", "burnham", "rammell", "starmer", "reform", "labour"];
  const comments = words.flatMap((w) => fromMany(`${w} again`, 2));
  const trends = computeTrends(comments, NOW, { limit: 4 });
  expect(trends.length).toBeLessThanOrEqual(4);
});

const trend = (word: string, score: number): Trend => ({ word, recent: 3, prior: 0, score });

test("a topic lingers for the dwell time after it stops trending", () => {
  const sticky = new Map<string, StickyEntry>();
  const t0 = 1_000_000;
  mergeStickyTrends([trend("eclipse", 10)], sticky, t0, { stickyMs: 180_000 });

  // 2 minutes later eclipse is no longer trending, but should still be shown.
  const at2m = mergeStickyTrends([trend("glasses", 8)], sticky, t0 + 120_000, { stickyMs: 180_000 });
  expect(at2m.map((t) => t.word)).toContain("eclipse");

  // 3+ minutes after it last trended, it drops.
  const at3m = mergeStickyTrends([trend("glasses", 8)], sticky, t0 + 181_000, { stickyMs: 180_000 });
  expect(at3m.map((t) => t.word)).not.toContain("eclipse");
});

test("a fresh topic still takes the lead over lingering ones", () => {
  const sticky = new Map<string, StickyEntry>();
  const t0 = 1_000_000;
  mergeStickyTrends([trend("eclipse", 10)], sticky, t0, { stickyMs: 180_000 });

  // eclipse fades (not in fresh) but a brand-new topic arrives — it must lead.
  const next = mergeStickyTrends([trend("burnham", 5)], sticky, t0 + 30_000, { stickyMs: 180_000 });
  expect(next[0]?.word).toBe("burnham");
  expect(next.map((t) => t.word)).toContain("eclipse");
});

test("termRegex matches whole words and phrases, case-insensitively", () => {
  expect(termRegex("Labour").test("blame Labour now")).toBe(true);
  expect(termRegex("labour").test("Labour did it")).toBe(true);
  expect(termRegex("Paul Cox").test("love Paul Cox tonight")).toBe(true);
  expect(termRegex("bill").test("a billion pounds")).toBe(false);
  expect(() => termRegex("C++ (test)")).not.toThrow();
});
