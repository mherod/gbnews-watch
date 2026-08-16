import { expect, test } from "bun:test";
import {
  computeTrends,
  isContentWord,
  mergeStickyTrends,
  normalize,
  stripNonProse,
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
  // Pinfold is deliberately NOT in the entity corpus — this exercises the
  // generic capitalisation boost, not the entity fast-path. Mid-sentence
  // position, because a sentence-initial capital carries no signal.
  // Neighbouring words vary per author so no bigram forms and absorbs the name.
  const trends = computeTrends(
    [
      c("blame Pinfold", { author: "a" }),
      c("ask Pinfold", { author: "b" }),
      c("folk reckon", { author: "c" }),
      c("all reckon", { author: "d" }),
    ],
    NOW,
  );
  expect(trends[0]?.word.toLowerCase()).toBe("pinfold");
});

test("a sentence-initial capital earns no proper-noun boost", () => {
  // "Apparently" opens every comment Capitalised — obligatory English, not a
  // name. At equal breadth the mid-sentence capitalised name must outrank it.
  // Only the word under test repeats; varied neighbours keep phrases out.
  const trends = computeTrends(
    [
      c("Apparently nobody checked", { author: "a" }),
      c("Apparently that broke", { author: "b" }),
      c("blame Pinfold today", { author: "d" }),
      c("ask Pinfold nicely", { author: "e" }),
    ],
    NOW,
  );
  const words = trends.map((t) => t.word.toLowerCase());
  expect(words).toContain("pinfold");
  expect(words).toContain("apparently");
  expect(words.indexOf("pinfold")).toBeLessThan(words.indexOf("apparently"));
});

// --- written numbers match their digit forms --------------------------------

test("a written number and its digit form are one topic", () => {
  // The observed split: "Saturday Five" trending while "SATURDAY 5" sat
  // unmatched in the next card.
  const trends = computeTrends(
    [
      ...fromMany("the Saturday Five is just slop", 3),
      ...Array.from({ length: 3 }, (_, i) => c("SATURDAY 5 DOING A GREAT JOB", { author: `d${i}` })),
    ],
    NOW,
  );
  const hits = trends.filter((t) => /saturday/i.test(t.word));
  expect(hits).toHaveLength(1); // one show, one chip
  expect(hits[0]!.recent).toBeGreaterThanOrEqual(6); // both spellings counted
  // The chip's matcher lights up and filters both spellings.
  const re = termRegex(hits[0]!.word, hits[0]!.pattern);
  expect(re.test("the Saturday Five is just slop")).toBe(true);
  expect(re.test("SATURDAY 5 DOING A GREAT JOB")).toBe(true);
});

test("bare digits and years still never trend", () => {
  const trends = computeTrends(fromMany("2024 was 100 percent worse", 6), NOW);
  expect(trends.some((t) => /^\d+$/.test(t.word))).toBe(false);
});

test("one and two stay stopwords rather than becoming digits", () => {
  const trends = computeTrends(fromMany("one thing or two things", 6), NOW);
  expect(trends.some((t) => /^(one|two|1|2)$/i.test(t.word))).toBe(false);
});

test("an ordinal never mints a phantom digit topic", () => {
  // "5th" is one ordinal, not a bare "5" plus a stray "th" — a split there
  // would pair the digit with its neighbour into an unmatchable "saturday 5".
  const trends = computeTrends(fromMany("the Saturday 5th protest looms", 6), NOW);
  expect(trends.some((t) => /\b5\b/.test(t.word))).toBe(false);
});

test("a folded number key still matches its written display form ('Rugby Sevens')", () => {
  // Every observed spelling is the written one; the key still folds to
  // "rugby 7" and the chip's matcher must cover both directions.
  const trends = computeTrends(fromMany("the Rugby Sevens again", 6), NOW);
  const hit = trends.find((t) => /rugby/i.test(t.word));
  expect(hit).toBeDefined();
  const re = termRegex(hit!.word, hit!.pattern);
  expect(re.test("the Rugby Sevens again")).toBe(true);
  expect(re.test("rugby 7 highlights")).toBe(true);
});

// --- overlapping windows of one repeated sentence ---------------------------

test("overlapping trigram windows of one rant collapse to the strongest", () => {
  // Observed live: "Fabian Society Invent" and "Society Invent Comunisim"
  // stood side by side — two windows over one four-word rant span.
  const trends = computeTrends(fromMany("Fabian Society Invent Comunisim", 6), NOW);
  const windows = trends.filter((t) => /society|invent|comunisim/i.test(t.word));
  expect(windows).toHaveLength(1);
});

test("consecutive bigram windows of one repeated line collapse to the strongest", () => {
  // Observed live: "open mic", "mic last" and "last night" all charted from
  // the same repeated sentence.
  const trends = computeTrends(fromMany("crowd at the open mic last night", 6), NOW);
  const windows = trends.filter((t) => /mic|night/i.test(t.word));
  expect(windows).toHaveLength(1);
});

test("a trigram sharing one word with each of two names keeps its chip", () => {
  // The fold must require a single anchor's re-windowed span — words claimed
  // by two DIFFERENT names must not add up to a fold.
  const comments = [
    ...fromMany("Zorblat Quixley Dinsdale rally", 5),
    ...Array.from({ length: 5 }, (_, i) => c("Yentob Marple Fenwick speech", { author: `b${i}` })),
    ...Array.from({ length: 4 }, (_, i) => c("Quixley Marple Debate tonight", { author: `d${i}` })),
  ];
  const words = computeTrends(comments, NOW, { limit: 8 }).map((t) => t.word.toLowerCase());
  expect(words).toContain("zorblat quixley dinsdale");
  expect(words).toContain("yentob marple fenwick");
  expect(words).toContain("quixley marple debate");
});

test("a true re-windowing shape folds only with lockstep support", () => {
  // Same suffix/prefix geometry, different crowds — both topics keep chips.
  const comments = [
    ...fromMany("Grand Wobbly Energy is a con", 4),
    ...Array.from({ length: 3 }, (_, i) => c("Wobbly Energy Prices went mad", { author: `h${i}` })),
  ];
  const words = computeTrends(comments, NOW, { limit: 8 }).map((t) => t.word.toLowerCase());
  expect(words).toContain("grand wobbly energy");
  expect(words).toContain("wobbly energy prices"); // display form, not the stem key
});

test("a chained bigram with its own support never folds (lockstep pinned)", () => {
  // Junction geometry alone must not fold: "boats everywhere" chains off
  // "stop boats" at the junction word but brings a different crowd.
  const comments = [
    ...fromMany("stop boats now", 4),
    ...Array.from({ length: 3 }, (_, i) => c("boats everywhere man", { author: `v${i}` })),
  ];
  const words = computeTrends(comments, NOW).map((t) => t.word.toLowerCase());
  expect(words).toContain("stop boats");
  expect(words.some((w) => w.includes("everywhere"))).toBe(true);
});

test("'per cent' never mints a bare 'cent' chip", () => {
  const trends = computeTrends(fromMany("interest rates at 5 per cent now", 6), NOW);
  expect(trends.some((t) => /^cent$/i.test(t.word))).toBe(false);
});

test("a sibling phrase sharing a word but with its own commenters survives", () => {
  const comments = [
    ...fromMany("stop boats now", 4),
    ...Array.from({ length: 3 }, (_, i) => c("small boats everywhere", { author: `v${i}` })),
  ];
  const trends = computeTrends(comments, NOW);
  const words = trends.map((t) => t.word.toLowerCase());
  expect(words).toContain("stop boats");
  expect(words).toContain("small boats");
});

test("prepositional glue never anchors a phrase chip ('via Left' regression)", () => {
  const trends = computeTrends(fromMany("pushed via Left wing groups", 6), NOW);
  expect(trends.some((t) => /\bvia\b/i.test(t.word))).toBe(false);
});

test("a spelling flip between ticks never doubles the chip", () => {
  const sticky = new Map<string, StickyEntry>();
  const t0 = 1_000_000;
  mergeStickyTrends([trend("Saturday Five", 8)], sticky, t0, { stickyMs: 180_000 });
  // Next tick the detector's best form is the digit spelling of the same show:
  // the sticky slot must roll over, not linger beside the fresh chip.
  const next = mergeStickyTrends([trend("SATURDAY 5", 9)], sticky, t0 + 30_000, { stickyMs: 180_000 });
  const words = next.map((t) => t.word.toLowerCase());
  expect(words).toContain("saturday 5");
  expect(words).not.toContain("saturday five");
});

test("sentence-adverb openers never trend as chips ('Sometimes' regression)", () => {
  // The observed defect: "Sometimes …" openers earned a chip and a taproom
  // node. It is a stopword now, whatever its capitalisation or breadth.
  const trends = computeTrends(fromMany("Sometimes I wonder about the council", 6), NOW);
  expect(trends.some((t) => t.word.toLowerCase().startsWith("sometime"))).toBe(false);
});

test("generic quantifiers never trend as topics ('another' regression)", () => {
  // Observed live as a taproom node: "another · 4". Breadth across authors is
  // exactly what a quantifier has and a topic needs — the word carries none.
  const trends = computeTrends(fromMany("another one gone and another after that", 6), NOW);
  expect(trends.some((t) => t.word.toLowerCase() === "another")).toBe(false);
});

test("the quantifier and indefinite-pronoun class is stopworded by stem", () => {
  // One assertion per word so a future regression names the exact hole. "others"
  // is checked through its stem, which is how isContentWord sees it.
  for (const word of [
    "another", "others", "other", "several", "few", "certain", "none", "both",
    "each", "either", "neither", "plenty", "anyone", "everyone", "nobody",
    "somebody", "everybody", "anybody", "someone",
  ]) {
    expect(isContentWord(normalize(word))).toBe(false);
  }
  // The guard rail: real topics in the same shape must still pass.
  for (const word of ["council", "Labour", "boats", "Farage"]) {
    expect(isContentWord(normalize(word))).toBe(true);
  }
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
  // "Allotment" is filler by breadth (one voice), not by vocabulary — the
  // point of the test. An indefinite pronoun would now be stopworded instead.
  const trends = computeTrends(
    [...fromMany("immigration", 3), c("Allotment", { author: "z" })],
    NOW,
    { minTrends: 3 },
  );
  expect(trends.find((t) => t.word.toLowerCase() === "immigration")?.weak).toBeFalsy();
  expect(trends.find((t) => t.word.toLowerCase() === "allotment")?.weak).toBe(true);
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

test("a corpus-confirmed name merges its short form even typed lowercase", () => {
  // All lowercase, so the capitalisation signal never fires — only the news
  // cycle knows "gerald pinfold" is one person's name. The name is kept out
  // of the entity corpus so this exercises the RSS-corpus path alone.
  const comments = [
    ...fromMany("pinfold has some nerve", 8),
    ...fromMany("gerald pinfold at it as usual", 3),
  ];
  const corpus = { stems: new Set<string>(), phrases: new Set(["gerald pinfold"]) };

  const merged = computeTrends(comments, NOW, { corpus, limit: 8 });
  const hits = merged.filter((t) => t.word.toLowerCase().includes("pinfold"));
  expect(hits).toHaveLength(1); // one person, one chip
  expect(hits[0]!.word.toLowerCase()).toBe("gerald pinfold"); // upgraded to the full name
  expect(hits[0]!.recent).toBeGreaterThanOrEqual(8); // carrying the short form's count

  // Without the corpus the lowercase phrase is dropped as redundant instead.
  const plain = computeTrends(comments, NOW, { limit: 8 });
  expect(plain.some((t) => t.word.toLowerCase() === "gerald pinfold")).toBe(false);
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

test("a fresh merged topic evicts its lingering short forms from the row", () => {
  const sticky = new Map<string, StickyEntry>();
  const t0 = 1_000_000;
  // Earlier ticks trended the fragments separately.
  mergeStickyTrends([trend("Cambridge", 6), trend("Andy", 4), trend("Burnham", 5)], sticky, t0, { stickyMs: 180_000 });

  // Now the detector merges them into full topics.
  const next = mergeStickyTrends(
    [trend("Cambridge University", 8), trend("Andy Burnham", 7), trend("Labour", 5)],
    sticky,
    t0 + 30_000,
    { stickyMs: 180_000 },
  );
  const words = next.map((t) => t.word);
  expect(words).toContain("Cambridge University");
  expect(words).toContain("Andy Burnham");
  expect(words).not.toContain("Cambridge"); // subsumed fragments are gone
  expect(words).not.toContain("Andy");
  expect(words).not.toContain("Burnham");
  expect(words).toContain("Labour"); // unrelated topics untouched
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

test("stripNonProse strips URLs, bare domains, emails, handles, and HTML markup", () => {
  expect(stripNonProse("check out https://example.com/page?v=123 now")).toBe("check out  .  now");
  expect(stripNonProse("visit www.gbnews.com for live coverage")).toBe("visit  .  for live coverage");
  expect(stripNonProse("email info@gbnews.uk or contact @reporter")).toBe("email  .  or contact  . ");
  expect(stripNonProse("<b>bold topic</b> and plain words")).toBe(" . bold topic .  and plain words");
});

test("a comment whose body is only a URL contributes no topics", () => {
  const trends = computeTrends(
    fromMany("youtube.com/watch?v=nVHNQpmUodw", 5),
    NOW,
    { minTrends: 0 },
  );
  expect(trends).toEqual([]);
});

test("prose in a comment that also contains a link is extracted normally without URL fragments", () => {
  const comments = [
    c("look at these taxes youtube.com/watch?v=nVHNQpmUodw completely unfair", { author: "a" }),
    c("taxes are absurd https://youtu.be/nVHNQpmUodw check this", { author: "b" }),
    c("cutting taxes is vital www.example.com/taxes-article", { author: "c" }),
  ];
  const trends = computeTrends(comments, NOW, { minTrends: 1 });
  const words = trends.map((t) => t.word.toLowerCase());
  expect(words).toContain("taxes");
  expect(words).not.toContain("youtube");
  expect(words).not.toContain("watch");
  expect(words).not.toContain("com");
  expect(words).not.toContain("nvhnqpmuodw");
});

test("stripping a URL breaks bigram and connective bridging across the stripped span", () => {
  // "disposable" and "BBQ" separated by a URL must NOT bridge into the bigram "disposable BBQ"
  const comments = fromMany("disposable https://example.com/link BBQ", 3);
  const trends = computeTrends(comments, NOW, { minTrends: 1 });
  const words = trends.map((t) => t.word.toLowerCase());
  expect(words).not.toContain("disposable bbq");
});

test("GB News and The Sun are matched as entities, consuming bare News and Sun unigrams", () => {
  const comments = [
    c("watching GB News today", { author: "a" }),
    c("saw this on GB News", { author: "b" }),
    c("reported in The Sun newspaper", { author: "c" }),
    c("read The Sun yesterday", { author: "d" }),
  ];
  const trends = computeTrends(comments, NOW, { minTrends: 1 });
  const words = trends.map((t) => t.word);
  expect(words).toContain("GB News");
  expect(words).toContain("The Sun");
  expect(words.map((w) => w.toLowerCase())).not.toContain("news");
  expect(words.map((w) => w.toLowerCase())).not.toContain("sun");
});

test("curated boilerplate tokens (e.g. gbnews, gbfamily) are not extracted as unigram topics", () => {
  const comments = [
    c("hello gbnews viewers", { author: "a" }),
    c("great gbnews broadcast", { author: "b" }),
    c("welcome gbfamily", { author: "c" }),
  ];
  const trends = computeTrends(comments, NOW, { minTrends: 0 });
  const words = trends.map((t) => t.word.toLowerCase());
  expect(words).not.toContain("gbnews");
  expect(words).not.toContain("gbfamily");
});

test("stems appearing in an implausibly high fraction of comments are suppressed as boilerplate", () => {
  // 16 distinct comments: 10 contain "stream" (not in corpus) -> DF > 35% -> suppressed
  // 4 contain "taxes" -> DF = 25% <= 35% -> extracted
  const comments: TrendInput[] = [];
  for (let i = 0; i < 16; i++) {
    const text = i < 10
      ? `great stream tonight ${i}`
      : i < 14
      ? `arguing about taxes and rates ${i}`
      : `weather is nice today ${i}`;
    comments.push(c(text, { author: `u${i}` }));
  }
  const trends = computeTrends(comments, NOW, { minTrends: 1 });
  const words = trends.map((t) => t.word.toLowerCase());
  expect(words.some((w) => w.includes("taxes"))).toBe(true);
  expect(words.some((w) => w.includes("stream"))).toBe(false);
});


