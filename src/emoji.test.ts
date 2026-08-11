import { expect, test } from "bun:test";
import { topEmoji } from "./emoji";

const NOW = 1_000_000_000_000;
const at = (body: string, ageMs = 10_000) => ({ body, postedAt: new Date(NOW - ageMs).toISOString() });

test("ranks emoji by frequency, ignoring text and one-offs", () => {
  const top = topEmoji(
    [at("haha 😂"), at("so funny 😂😂"), at("great 👏"), at("well said 👏"), at("meh 🤔")],
    NOW,
  );
  expect(top[0]).toEqual({ emoji: "😂", count: 3 });
  expect(top.find((e) => e.emoji === "👏")?.count).toBe(2);
  // 🤔 appeared once → below the floor of 2
  expect(top.some((e) => e.emoji === "🤔")).toBe(false);
});

test("keeps compound emoji (flags) whole", () => {
  const top = topEmoji([at("proud 🇬🇧"), at("yes 🇬🇧"), at("go on 🇬🇧")], NOW);
  expect(top[0]).toEqual({ emoji: "🇬🇧", count: 3 });
});

test("respects the time window", () => {
  const top = topEmoji([at("😂"), at("😂", 999_999)], NOW, { windowMs: 60_000 });
  // only one 😂 is within the window → below the floor of 2
  expect(top).toHaveLength(0);
});
