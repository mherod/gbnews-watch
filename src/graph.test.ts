import { expect, test } from "bun:test";
import { buildTopicGraph, type GraphInput } from "./graph";
import type { Trend } from "./trending";

const NOW = 1_000_000_000_000;
const at = (body: string, author: string, ageMs = 10_000): GraphInput => ({
  body,
  author,
  postedAt: new Date(NOW - ageMs).toISOString(),
});
const t = (word: string, extra: Partial<Trend> = {}): Trend => ({
  word,
  recent: 3,
  prior: 0,
  score: 10,
  ...extra,
});

test("links two topics raised in the same comment", () => {
  const graph = buildTopicGraph(
    [at("Labour and migrants again", "a"), at("migrants and Labour, always", "b"), at("just Labour", "c")],
    [t("Labour"), t("migrants")],
    NOW,
  );
  const link = graph.links.find((l) => l.source === "Labour" && l.target === "migrants");
  expect(link?.weight).toBe(2); // co-mentioned twice, not three times
});

test("counts distinct voices, not raw mentions", () => {
  const graph = buildTopicGraph(
    [at("boats", "a"), at("boats", "a"), at("boats", "b")],
    [t("boats")],
    NOW,
  );
  const node = graph.nodes.find((n) => n.id === "boats");
  expect(node?.mentions).toBe(3);
  expect(node?.voices).toBe(2); // one author posted twice
});

test("colours a topic by the sentiment of comments that mention it", () => {
  const graph = buildTopicGraph(
    [at("Labour are a disgrace and useless", "a"), at("Labour, what a joke", "b")],
    [t("Labour")],
    NOW,
  );
  expect(graph.nodes[0]!.sentiment).toBeLessThan(0);
});

test("drops topics nobody mentioned in the window", () => {
  const graph = buildTopicGraph(
    [at("boats", "a"), at("boats", "b", 999_999)], // second is outside the window
    [t("boats"), t("eclipse")],
    NOW,
    { windowMs: 60_000 },
  );
  expect(graph.nodes.map((n) => n.id)).toEqual(["boats"]);
  expect(graph.nodes[0]!.mentions).toBe(1);
});

test("uses an entity pattern so aliases feed the same node", () => {
  const graph = buildTopicGraph(
    [at("typical Tory nonsense", "a"), at("the Tories again", "b")],
    [t("Conservative", { pattern: "conservatives|conservative|tories|tory" })],
    NOW,
  );
  expect(graph.nodes[0]?.voices).toBe(2); // both aliases counted on the canonical node
});

test("carries the weak flag through for faint rendering", () => {
  const graph = buildTopicGraph([at("blip", "a")], [t("blip", { weak: true })], NOW);
  expect(graph.nodes[0]?.weak).toBe(true);
});

test("returns an empty graph when there are no trends", () => {
  expect(buildTopicGraph([at("anything", "a")], [], NOW)).toEqual({ nodes: [], links: [] });
});
