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
  // lowercase lead-in so the capitalised run is exactly the two-word name
  const trends = computeTrends(fromMany("yesss Paul Cox", 3), NOW);
  const words = trends.map((t) => t.word.toLowerCase());
  expect(words).toContain("paul cox");
  expect(words).not.toContain("paul");
  expect(words).not.toContain("cox");
});

test("a specific phrase folds into the bare word that dominates it", () => {
  // 8 people say "bbq's", 4 say "disposable BBQ" — one topic, not two chips.
  const bbq = [
    "these bbq's should be banned",
    "who leaves bbq's about",
    "bbq's again honestly",
    "the bbq's caused it",
    "ban bbq's outright",
    "bbq's every summer",
    "another of those bbq's",
    "bbq's are the issue",
  ].map((body, i) => c(body, { author: `b${i}` }));
  const disposable = [
    "a disposable BBQ started it",
    "disposable BBQ of course",
    "blame the disposable BBQ",
    "disposable BBQ nonsense",
  ].map((body, i) => c(body, { author: `d${i}` }));

  const words = computeTrends([...bbq, ...disposable], NOW, { limit: 8 }).map((t) => t.word.toLowerCase());
  expect(words.filter((w) => w.includes("bbq"))).toHaveLength(1); // one BBQ topic
  expect(words).not.toContain("disposable bbq"); // the minority phrase folds in
  expect(words).not.toContain("disposable"); // and doesn't leak its own word
});

test("the word that absorbs a phrase keeps the bigger count", () => {
  const trends = computeTrends(
    [
      ...fromMany("toilets are filthy", 6),
      ...fromMany("the public toilets closed", 3),
    ],
    NOW,
    { limit: 8 },
  );
  const toilet = trends.find((t) => t.word.toLowerCase().includes("toilet"));
  expect(toilet).toBeTruthy();
  expect(toilet!.recent).toBeGreaterThanOrEqual(9); // all mentions, not just one form's
});

test("a dropped phrase does not delete a bare word that outranks it", () => {
  // "migrants" is the big topic; a smaller overlapping phrase must not take it
  // down with it when that phrase loses its slot.
  const trends = computeTrends(
    [
      ...fromMany("migrants arriving daily", 9),
      ...fromMany("illegal migrants again", 3),
    ],
    NOW,
    { limit: 8 },
  );
  const migrants = trends.filter((t) => t.word.toLowerCase().includes("migrant"));
  expect(migrants.length).toBeGreaterThanOrEqual(1); // the topic survives
  expect(Math.max(...migrants.map((t) => t.recent))).toBeGreaterThanOrEqual(9);
});

test("folds overlapping name-bigrams into one full-name trigram", () => {
  const trends = computeTrends(fromMany("Muhammad Ziauddin Yusuf is a disgrace", 6), NOW, { limit: 8 });
  const words = trends.map((t) => t.word);
  expect(words).toContain("Muhammad Ziauddin Yusuf"); // the full name, once
  expect(words).not.toContain("Muhammad Ziauddin"); // not the overlapping halves
  expect(words).not.toContain("Ziauddin Yusuf");
  expect(words.some((w) => w.toLowerCase() === "ziauddin")).toBe(false); // no bare middle name
  expect(words.filter((w) => w.toLowerCase().includes("ziauddin"))).toHaveLength(1);
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

test("folds singular and plural into one trend", () => {
  const trends = computeTrends(
    [c("toilet", { author: "a" }), c("toilets", { author: "b" }), c("toilet", { author: "c" })],
    NOW,
  );
  const toilet = trends.find((t) => t.word.toLowerCase().startsWith("toilet"));
  expect(toilet?.recent).toBe(3);
});

test("boosts a proper noun over a generic word of equal breadth", () => {
  const trends = computeTrends(
    [
      c("Burnham", { author: "a" }),
      c("Burnham", { author: "b" }),
      c("reckon", { author: "c" }),
      c("reckon", { author: "d" }),
    ],
    NOW,
  );
  expect(trends[0]?.word.toLowerCase()).toBe("burnham");
});

test("merges an overlapping proper-noun bigram and unigram into one topic", () => {
  const comments = [
    ...Array.from({ length: 8 }, (_, i) => c("Stadlen", { author: `u${i}` })),
    ...Array.from({ length: 3 }, (_, i) => c("Matthew Stadlen", { author: `m${i}` })),
  ];
  const trends = computeTrends(comments, NOW);
  const stadlen = trends.filter((t) => t.word.toLowerCase().includes("stadlen"));
  expect(stadlen).toHaveLength(1); // one topic, not two chips
  expect(stadlen[0]!.word).toBe("Matthew Stadlen"); // upgraded to the full name
  expect(stadlen[0]!.recent).toBeGreaterThanOrEqual(8); // carries the dominant count
});

test("bridges a stopword gap to surface 'stop the boats'", () => {
  const words = computeTrends(fromMany("We need to stop the boats", 3), NOW).map((t) => t.word.toLowerCase());
  expect(words).toContain("stop the boats");
  expect(words).not.toContain("stop"); // endpoints folded into the phrase
  expect(words).not.toContain("boats");
});

test("a connective phrase needs more than one voice", () => {
  const solo = Array.from({ length: 4 }, () => c("stop the boats", { author: "solo" }));
  const words = computeTrends(solo, NOW, { minTrends: 1 }).map((t) => t.word.toLowerCase());
  expect(words).not.toContain("stop the boats"); // one ranter can't manufacture a phrase
});

test("does not bridge a connective phrase across punctuation", () => {
  const words = computeTrends(fromMany("stop. the boats", 3), NOW).map((t) => t.word.toLowerCase());
  expect(words).not.toContain("stop the boats");
});

test("a consistently capitalised word outranks a sometimes-capitalised one", () => {
  const trends = computeTrends(
    [
      c("Farage", { author: "a" }),
      c("Farage", { author: "b" }),
      c("Reform", { author: "c" }),
      c("reform", { author: "d" }), // only capitalised half the time
    ],
    NOW,
  );
  const words = trends.map((t) => t.word.toLowerCase());
  expect(words.indexOf("farage")).toBeLessThan(words.indexOf("reform"));
});

test("strips a contraction so it becomes a stopword", () => {
  const trends = computeTrends(
    [c("there's a problem", { author: "a" }), c("there's a problem", { author: "b" })],
    NOW,
  );
  expect(trends.some((t) => t.word.toLowerCase().includes("there"))).toBe(false);
});

test("collapses overlapping fragments of one repeated sentence into a single topic", () => {
  const trends = computeTrends(fromMany("Tucker Carlson is in bed with Dubai", 7), NOW, { limit: 8, minTrends: 1 });
  const words = trends.map((t) => t.word);
  expect(words).toContain("Tucker Carlson");
  expect(words).not.toContain("Carlson is in bed"); // fragments of the same sentence
  expect(words).not.toContain("bed with Dubai");
  expect(words.some((w) => w.toLowerCase() === "bed")).toBe(false); // no bare fragment word
  expect(words.some((w) => w.toLowerCase() === "dubai")).toBe(false);
  expect(words.filter((w) => w.toLowerCase().includes("carlson"))).toHaveLength(1); // one chip
});

test("flags single-voice filler weak but leaves real trends unmarked", () => {
  const trends = computeTrends(
    [...fromMany("immigration", 3), c("Nobody", { author: "z" })],
    NOW,
    { minTrends: 3 },
  );
  expect(trends.find((t) => t.word.toLowerCase() === "immigration")?.weak).toBeFalsy();
  expect(trends.find((t) => t.word.toLowerCase() === "nobody")?.weak).toBe(true);
});

test("a term repeated by one person is filler, not a real trend", () => {
  const trends = computeTrends(
    Array.from({ length: 5 }, () => c("Rammell", { author: "solo" })), // 1 author, 5×
    NOW,
    { minTrends: 1 },
  );
  const rammell = trends.find((t) => t.word.toLowerCase() === "rammell");
  expect(rammell).toBeTruthy(); // still shown so the row isn't empty
  expect(rammell?.weak).toBe(true); // but muted — one voice isn't a trend
});

test("a news-cycle corpus term outranks an equal term outside the cycle", () => {
  // Single words so the pair is genuinely tied — a two-content-word body would
  // form its own boosted bigram and decide the race for unrelated reasons.
  const comments = [
    ...fromMany("hotels", 3),
    ...fromMany("weather", 3),
  ];
  const corpus = { stems: new Set(["hotel"]), phrases: new Set<string>() };
  const withCorpus = computeTrends(comments, NOW, { corpus, minTrends: 1 });
  expect(withCorpus[0]?.word.toLowerCase()).toBe("hotels");
  // Without the corpus the two are genuinely tied — the boost decided it.
  const without = computeTrends(comments, NOW, { minTrends: 1 });
  const scores = without.map((t) => t.score);
  expect(scores[0]).toBe(scores[1]!);
});

const trend = (word: string, score: number): Trend => ({ word, recent: 3, prior: 0, score, authors: 3 });
const weak = (word: string, score: number): Trend => ({ word, recent: 1, prior: 0, score, weak: true });

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

test("single-voice filler never lingers like a real trend", () => {
  const sticky = new Map<string, StickyEntry>();
  const t0 = 1_000_000;
  mergeStickyTrends([weak("blip", 9)], sticky, t0, { stickyMs: 180_000 });
  // A tick later the filler is gone from fresh; it must not have been stored.
  const next = mergeStickyTrends([trend("burnham", 5)], sticky, t0 + 30_000, { stickyMs: 180_000 });
  expect(next.map((t) => t.word)).not.toContain("blip");
});

test("a lingering real trend outranks fresh single-voice filler", () => {
  const sticky = new Map<string, StickyEntry>();
  const t0 = 1_000_000;
  mergeStickyTrends([trend("eclipse", 10)], sticky, t0, { stickyMs: 180_000 });
  // Next tick only filler is fresh — the faded real trend should still lead.
  const next = mergeStickyTrends([weak("wibble", 99)], sticky, t0 + 30_000, { stickyMs: 180_000 });
  expect(next[0]?.word).toBe("eclipse");
});

test("termRegex matches whole words and phrases, case-insensitively", () => {
  expect(termRegex("Labour").test("blame Labour now")).toBe(true);
  expect(termRegex("labour").test("Labour did it")).toBe(true);
  expect(termRegex("Paul Cox").test("love Paul Cox tonight")).toBe(true);
  expect(termRegex("bill").test("a billion pounds")).toBe(false);
  expect(() => termRegex("C++ (test)")).not.toThrow();
});

test("termRegex with a pattern matches every alias of an entity", () => {
  const re = termRegex("Conservative", "conservative party|conservatives|conservative|tories|tory");
  expect(re.test("blame the Tories")).toBe(true);
  expect(re.test("a Conservative view")).toBe(true);
  expect(re.test("nothing here")).toBe(false);
});

test("a two-letter entity surfaces even though the length filter would drop it", () => {
  const trends = computeTrends(fromMany("the EU is the problem", 3), NOW, { minTrends: 1 });
  expect(trends.some((t) => t.word === "EU")).toBe(true);
});

test("merges party aliases into one canonical chip carrying the combined count", () => {
  const trends = computeTrends(
    [
      c("Tory sleaze again", { author: "a" }),
      c("the Tories are finished", { author: "b" }),
      c("typical Conservative government", { author: "c" }),
    ],
    NOW,
    { minTrends: 1 },
  );
  const con = trends.filter((t) => t.word === "Conservative");
  expect(con).toHaveLength(1); // one chip, not three
  expect(con[0]!.recent).toBe(3); // Tory + Tories + Conservative all counted
  expect(con[0]!.pattern).toContain("tory"); // alias-aware highlight/filter
  expect(trends.some((t) => t.word.toLowerCase() === "tory")).toBe(false); // no bare alias chip
});

test("a lowercase ambiguous alias does not conjure an entity", () => {
  const trends = computeTrends(fromMany("we need reform of the system", 3), NOW, { minTrends: 1 });
  expect(trends.some((t) => t.word === "Reform UK")).toBe(false); // lowercase 'reform' is the verb
});
