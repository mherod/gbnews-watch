/**
 * Harvest sentiment-lexicon candidates from the live feed.
 *
 * Pulls the recent comment window from a running dev server and prints, with
 * counts and sample context:
 *   1. frequent words the LEXICON doesn't score (stopwords/entities excluded),
 *   2. unscored variants of words the LEXICON *does* score (clown vs clowns),
 *   3. emoji with no EMOJI_LEXICON entry.
 *
 * Usage: bun scripts/debug-sentiment-gaps.ts [port]   (default 62762)
 */

import { LEXICON, emojiSentiment } from "../src/sentiment";
import { STOPWORDS } from "../src/trending";
import { matchEntityAt } from "../src/entities";

const port = Number(Bun.argv[2] ?? 62762);
const url = `http://localhost:${port}/api/health`;
console.log("--- fetch ---");
console.log("url:", url);

const res = await fetch(url);
console.log("status:", res.status);
const data = await res.json();
const comments: { body: string }[] = Array.isArray(data.comments) ? data.comments : [];
console.log("comments:", comments.length, "  <-- expected 40-150 from the rolling window");

const WORD = /[\p{L}][\p{L}']*/gu;
const EMOJI_GRAPHEME = /\p{Extended_Pictographic}/u;
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The same light fold sentiment scoring would need ("clowns" → "clown"). */
function fold(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

const unscored = new Map<string, { count: number; samples: Set<string> }>();
const variantGaps = new Map<string, { count: number; scored: string }>();
const unscoredEmoji = new Map<string, number>();

for (const c of comments) {
  const body = c.body;
  for (const m of body.matchAll(WORD)) {
    const raw = m[0];
    const w = raw.toLowerCase();
    if (w.length < 3) continue;
    if (LEXICON[w] !== undefined) continue;
    const folded = fold(w);
    if (LEXICON[folded] !== undefined) {
      const e = variantGaps.get(w) ?? { count: 0, scored: folded };
      e.count += 1;
      variantGaps.set(w, e);
      continue;
    }
    if (STOPWORDS.has(w)) continue;
    if (matchEntityAt([raw], 0)) continue; // topics, not sentiment
    const e = unscored.get(w) ?? { count: 0, samples: new Set() };
    e.count += 1;
    if (e.samples.size < 2) e.samples.add(body.replace(/\s+/g, " ").slice(0, 90));
    unscored.set(w, e);
  }
  for (const { segment } of seg.segment(body)) {
    if (!EMOJI_GRAPHEME.test(segment)) continue;
    if (emojiSentiment(segment) !== undefined) continue;
    unscoredEmoji.set(segment, (unscoredEmoji.get(segment) ?? 0) + 1);
  }
}

console.log("\n--- unscored words (count >= 2, top 40) ---");
const top = [...unscored.entries()].filter(([, e]) => e.count >= 2).sort((a, b) => b[1].count - a[1].count).slice(0, 40);
console.log("distinct unscored words:", unscored.size, "; shown:", top.length);
for (const [w, e] of top) {
  console.log(`${String(e.count).padStart(3)}  ${w}`);
  for (const s of e.samples) console.log(`       "${s}"`);
}

console.log("\n--- variants of scored words (any count) ---");
for (const [w, e] of [...variantGaps.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`${String(e.count).padStart(3)}  ${w}  (scored form: ${e.scored} = ${LEXICON[e.scored]})`);
}

console.log("\n--- unscored emoji ---");
for (const [g, n] of [...unscoredEmoji.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(3)}  ${g}`);
}
