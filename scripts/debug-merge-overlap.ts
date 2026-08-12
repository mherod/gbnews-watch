/**
 * Why do "bbq's" and "disposable BBQ" both show as separate trends?
 *
 * Reproduces the live case from the trend row: a bare word mentioned 8 times
 * and a more specific phrase containing it mentioned 4 times. Prints the stems
 * and capitalisation flags the merge rule depends on, then the resulting chips.
 *
 * Run: bun scripts/debug-merge-overlap.ts
 */

import { computeTrends, isCapitalized, normalize } from "../src/trending";

const now = Date.now();
const c = (body: string, author: string) => ({
  body,
  author,
  postedAt: new Date(now - 20_000).toISOString(),
});

console.log("--- inputs the merge rule reads ---");
console.log("normalize(\"bbq's\") =", normalize("bbq's"), "  <-- expected 'bbq'");
console.log('normalize("BBQ")    =', normalize("BBQ"));
console.log('isCapitalized("disposable") =', isCapitalized("disposable"), " <-- gates the name path");
console.log('isCapitalized("BBQ")        =', isCapitalized("BBQ"), " <-- ALL-CAPS is deliberately not a name");

// 8 mentions of the bare word, 4 of the specific phrase — as in the screenshot.
const data = [
  ...Array.from({ length: 8 }, (_, i) => c("ban the bbq's now", `u${i}`)),
  ...Array.from({ length: 4 }, (_, i) => c("a disposable BBQ is the problem", `d${i}`)),
];

console.log("\n--- resulting chips ---");
for (const t of computeTrends(data, now, { limit: 8, minTrends: 3 })) {
  console.log(`  ${String(t.word).padEnd(18)} recent=${t.recent} score=${t.score.toFixed(1)}`);
}

// Closer to the live row, where the words appear in varied sentences rather
// than one repeated phrase (which would form its own connective).
console.log("\n--- faithful screenshot case ---");
// Each sentence differs, as real comments do — otherwise a repeated sentence
// forms its own connective phrase and masks what the merge rule did.
const bbqLines = [
  "these bbq's should be banned",
  "who leaves bbq's lying about",
  "bbq's again, honestly",
  "the bbq's caused it",
  "ban bbq's outright",
  "bbq's every summer",
  "another one of those bbq's",
  "bbq's are the issue here",
];
const dispLines = [
  "a disposable BBQ started it",
  "disposable BBQ, of course",
  "blame the disposable BBQ",
  "disposable BBQ nonsense",
];
const varied = [
  ...bbqLines.map((line, i) => c(line, `b${i}`)),
  ...dispLines.map((line, i) => c(line, `d${i}`)),
  ...Array.from({ length: 6 }, (_, i) => c(`migrants ${["again", "arriving", "here", "today", "once more", "still"][i]}`, `m${i}`)),
];
for (const t of computeTrends(varied, now, { limit: 8, minTrends: 3 })) {
  console.log(`  ${String(t.word).padEnd(18)} recent=${t.recent} score=${t.score.toFixed(1)}`);
}

console.log("\n--- regression cases that must keep working ---");
const paulCox = computeTrends(
  Array.from({ length: 3 }, (_, i) => c("yesss Paul Cox", `p${i}`)),
  now,
);
console.log("  Paul Cox:", paulCox.map((t) => `${t.word}(${t.recent})`).join(", "));

const stadlen = computeTrends(
  [
    ...Array.from({ length: 8 }, (_, i) => c("Stadlen", `s${i}`)),
    ...Array.from({ length: 3 }, (_, i) => c("Matthew Stadlen", `m${i}`)),
  ],
  now,
);
console.log("  Stadlen:", stadlen.map((t) => `${t.word}(${t.recent})`).join(", "));
