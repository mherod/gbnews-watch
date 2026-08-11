import { expect, test } from "bun:test";
import { roomMood, scoreText } from "./sentiment";

const NOW = 1_000_000_000_000;
const at = (body: string, ageMs = 10_000) => ({ body, postedAt: new Date(NOW - ageMs).toISOString() });

test("scoreText is negative for an angry comment", () => {
  expect(scoreText("This is an absolute disgrace and a joke")!).toBeLessThan(0);
});

test("scoreText is positive for a happy comment", () => {
  expect(scoreText("Brilliant, love it, well done")!).toBeGreaterThan(0);
});

test("scoreText returns null when there is no sentiment vocabulary", () => {
  expect(scoreText("the council meeting is on tuesday")).toBeNull();
});

test("negation flips the sign", () => {
  expect(scoreText("not great")!).toBeLessThan(0);
  expect(scoreText("this isn't terrible")!).toBeGreaterThan(0);
});

test("emoji count toward sentiment", () => {
  expect(scoreText("well 🤬")!).toBeLessThan(0); // angry emoji
  expect(scoreText("👏")!).toBeGreaterThan(0); // no words, emoji only
  expect(scoreText("hmm 🤣")!).toBeGreaterThan(0);
});

test("roomMood reads a heated room", () => {
  const comments = [
    at("absolute disgrace"),
    at("what a joke"),
    at("corrupt and useless"),
    at("pathetic liar"),
    at("shameful nonsense"),
  ];
  const mood = roomMood(comments, NOW, { minScored: 5 });
  expect(mood?.tone).toBe("heated");
  expect(mood?.score).toBeLessThan(0);
});

test("roomMood reads an upbeat room", () => {
  const comments = [
    at("brilliant show"),
    at("love it"),
    at("fantastic guest"),
    at("well done, great"),
    at("wonderful, respect"),
  ];
  const mood = roomMood(comments, NOW, { minScored: 5 });
  expect(mood).not.toBeNull();
  expect(["warm", "buzzing"]).toContain(mood!.tone);
});

test("leans to a side rather than collapsing to mixed", () => {
  // 4 angry : 1 happy — the mean would be near zero, but the balance is clearly heated.
  const comments = [at("disgrace"), at("what a joke"), at("useless"), at("pathetic liar"), at("brilliant")];
  const mood = roomMood(comments, NOW, { minScored: 5 });
  expect(mood?.tone).toBe("heated");
});

test("spells out the mix when genuinely divided", () => {
  const comments = [at("disgrace"), at("what a joke"), at("useless"), at("brilliant"), at("love it"), at("fantastic")];
  const mood = roomMood(comments, NOW, { minScored: 6 });
  expect(mood?.tone).toBe("mixed");
  expect(mood?.label).toBe("Divided");
  expect(mood?.detail).toMatch(/%/);
});

test("roomMood is null until enough comments carry sentiment", () => {
  expect(roomMood([at("brilliant")], NOW, { minScored: 5 })).toBeNull();
});
