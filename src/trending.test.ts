import { expect, test } from "bun:test";
import { computeTrends, termRegex, type TrendInput } from "./trending";

const NOW = 1_000_000_000_000;

/** `n` comments with `body`, spread across the recent window (default) or older. */
function say(body: string, n: number, ageMs = 10_000): TrendInput[] {
  return Array.from({ length: n }, () => ({ body, postedAt: new Date(NOW - ageMs).toISOString() }));
}

test("surfaces a word surging in the last minute", () => {
  const comments = [
    ...say("Dougie is a legend", 4),
    ...say("boring weather chat", 1, 90_000), // older baseline
  ];
  const trends = computeTrends(comments, NOW);
  expect(trends[0]?.word.toLowerCase()).toBe("dougie");
  expect(trends[0]?.recent).toBe(4);
});

test("detects a two-word phrase and suppresses its parts", () => {
  const trends = computeTrends(say("Yesss Paul Cox", 5), NOW);
  const words = trends.map((t) => t.word.toLowerCase());
  expect(words).toContain("paul cox");
  expect(words).not.toContain("paul");
  expect(words).not.toContain("cox");
});

test("preserves the phrase's original casing", () => {
  const trends = computeTrends(say("love Paul Cox tonight", 5), NOW);
  expect(trends.find((t) => t.word === "Paul Cox")).toBeTruthy();
});

test("does not bridge a phrase across punctuation", () => {
  // "Yesss" and "Paul" are separated by punctuation, so they must not form a phrase.
  const trends = computeTrends(say("Yesss.... Paul is great", 5), NOW);
  expect(trends.some((t) => t.word.toLowerCase() === "yesss paul")).toBe(false);
});

test("ignores a term that is merely frequent, not rising", () => {
  const comments = [
    ...say("migrants again", 4, 10_000), // recent
    ...say("migrants again", 4, 90_000), // equally common before → not rising
  ];
  const trends = computeTrends(comments, NOW);
  expect(trends.some((t) => t.word.toLowerCase() === "migrants")).toBe(false);
});

test("ignores stopwords and words below the count floor", () => {
  const trends = computeTrends(
    [...say("they are here now", 5), ...say("Ono", 2)],
    NOW,
  );
  expect(trends.some((t) => STOPSAMPLE.includes(t.word.toLowerCase()))).toBe(false);
  expect(trends.some((t) => t.word.toLowerCase() === "ono")).toBe(false); // only 2 < floor of 3
});

const STOPSAMPLE = ["they", "are", "here", "now"];

test("termRegex matches whole words and phrases, case-insensitively", () => {
  expect(termRegex("Labour").test("blame Labour now")).toBe(true);
  expect(termRegex("labour").test("Labour did it")).toBe(true);
  expect(termRegex("Paul Cox").test("love Paul Cox tonight")).toBe(true);
  // whole-word only: "bill" must not match "billion"
  expect(termRegex("bill").test("a billion pounds")).toBe(false);
  // a term with regex-special chars is treated literally
  expect(() => termRegex("C++ (test)")).not.toThrow();
});

test("counts each word once per comment so one ranter can't dominate", () => {
  const trends = computeTrends(
    [
      { body: "Dougie Dougie Dougie Dougie Dougie", postedAt: new Date(NOW - 5_000).toISOString() },
      ...say("weather", 1, 90_000),
    ],
    NOW,
  );
  // A single comment repeating the word 5x counts as 1, below the floor of 3.
  expect(trends.some((t) => t.word.toLowerCase() === "dougie")).toBe(false);
});
