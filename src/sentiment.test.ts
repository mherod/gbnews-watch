import { expect, test } from "bun:test";
import { classify, roomMood, scoreText } from "./sentiment";

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

test("plurals fold onto their singular entries", () => {
  expect(scoreText("bunch of clowns")!).toBeLessThan(0); // only "clown" is scored
  expect(scoreText("high hopes for this")!).toBeGreaterThan(0); // only "hope" is scored
  expect(scoreText("the illegals again")!).toBeLessThan(0);
});

test("harvested live-feed vocabulary scores", () => {
  expect(scoreText("what an obnoxious stooge")!).toBeLessThan(0);
  expect(scoreText("the Labour mouthpiece strikes again")!).toBeLessThan(0);
  expect(scoreText("utter twaddle from that tosser")!).toBeLessThan(0);
  expect(scoreText("stop gaslighting us")!).toBeLessThan(0);
  expect(scoreText("🤞")!).toBeGreaterThan(0);
  expect(scoreText("🥂")!).toBeGreaterThan(0);
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

// --- hysteresis: the pill holds its label across a boundary graze -----------
// `classify` takes counts, so these express a balance directly: neg out of 100.

test("without a previous tone the thresholds are unchanged", () => {
  expect(classify(50, 50).tone).toBe("mixed"); // 0.50
  expect(classify(46, 54).tone).toBe("mixed"); // 0.46 — still inside Divided
  expect(classify(42, 58).tone).toBe("warm"); // 0.42 — below Divided's floor
  expect(classify(58, 42).tone).toBe("grumbly"); // 0.58
  expect(classify(28, 72).tone).toBe("buzzing"); // boundary belongs to buzzing
  expect(classify(44, 56).tone).toBe("warm"); // boundary belongs to warm
});

test("a held tone survives a small overshoot past its boundary", () => {
  // The observed flap: Divided (0.44–0.56) grazing either edge.
  expect(classify(58, 42, "mixed").tone).toBe("mixed"); // 0.58 — would be grumbly
  expect(classify(42, 58, "mixed").tone).toBe("mixed"); // 0.42 — would be warm
  // A lean holds too: warm (0.28–0.44) is kept just inside Divided's band.
  expect(classify(46, 54, "warm").tone).toBe("warm"); // 0.46 — would be mixed
});

test("a decisive swing still relabels the room", () => {
  // Past the margin, the new reading wins — hysteresis calms, it never hides.
  expect(classify(61, 39, "mixed").tone).toBe("grumbly"); // 0.61 > 0.56 + 0.04
  expect(classify(39, 61, "mixed").tone).toBe("warm"); // 0.39 < 0.44 − 0.04
  expect(classify(80, 20, "mixed").tone).toBe("heated"); // no contest
  expect(classify(49, 51, "warm").tone).toBe("mixed"); // 0.49 > 0.44 + 0.04
});

test("a held Divided still reports the real mix it is drifting toward", () => {
  const held = classify(58, 42, "mixed");
  expect(held.label).toBe("Divided");
  expect(held.detail).toContain("58%"); // honest about the balance, not the label
});

test("roomMood threads the previous tone through to the label", () => {
  // 3 angry : 3 happy is 0.50 — Divided. Adding a fourth angry comment makes it
  // 0.57, which alone reads grumbly; carrying the tone holds the pill steady.
  const divided = [at("disgrace"), at("what a joke"), at("useless"), at("brilliant"), at("love it"), at("fantastic")];
  const drifted = [...divided, at("pathetic")];
  expect(roomMood(drifted, NOW, { minScored: 6 })?.tone).toBe("grumbly");
  expect(roomMood(drifted, NOW, { minScored: 6, previousTone: "mixed" })?.tone).toBe("mixed");
});
