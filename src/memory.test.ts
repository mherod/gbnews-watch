import { expect, test } from "bun:test";
import {
  decayMemory,
  deserializeMemory,
  edgeKey,
  emptyMemory,
  memoryToGraph,
  reinforceMemory,
  serializeMemory,
  type MemoryInput,
} from "./memory";
import type { Trend } from "./trending";

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const t = (word: string, extra: Partial<Trend> = {}): Trend => ({ word, recent: 3, prior: 0, score: 10, ...extra });
const c = (id: string, body: string, author = "a"): MemoryInput => ({
  id,
  body,
  author,
  postedAt: new Date(NOW).toISOString(),
});

test("reinforces a link each time two topics are argued together", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("Labour"), t("migrants")];
  reinforceMemory(mem, [c("1", "Labour and migrants")], trends, NOW);
  expect(mem.edges[edgeKey("labour", "migrants")]?.weight).toBe(1);

  reinforceMemory(mem, [c("2", "migrants, blame Labour")], trends, NOW);
  expect(mem.edges[edgeKey("labour", "migrants")]?.weight).toBe(2); // accumulated, not recomputed
});

test("never counts the same comment twice", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("boats")];
  const batch = [c("1", "boats")];
  reinforceMemory(mem, batch, trends, NOW);
  reinforceMemory(mem, batch, trends, NOW); // same comment resent by a re-render
  expect(mem.nodes["boats"]?.weight).toBe(1);
});

test("an association survives long after it leaves the live window", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Labour and migrants")], [t("Labour"), t("migrants")], NOW);
  // 20 minutes later nothing new has been said about them at all.
  decayMemory(mem, NOW + 20 * MIN, { halfLifeMs: 45 * MIN });
  expect(mem.edges[edgeKey("labour", "migrants")]?.weight).toBeGreaterThan(0.5); // still remembered
});

test("decays by half over one half-life", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "boats")], [t("boats")], NOW);
  decayMemory(mem, NOW + 45 * MIN, { halfLifeMs: 45 * MIN });
  expect(mem.nodes["boats"]!.weight).toBeCloseTo(0.5, 5);
});

test("forgets an association that stops being made", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "eclipse")], [t("eclipse")], NOW);
  decayMemory(mem, NOW + 8 * 60 * MIN, { halfLifeMs: 45 * MIN }); // 8 hours of silence
  expect(mem.nodes["eclipse"]).toBeUndefined();
});

test("a repeatedly-argued pair outweighs a one-off pair", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("Labour"), t("migrants"), t("weather"), t("bins")];
  for (let i = 0; i < 6; i++) {
    reinforceMemory(mem, [c(`x${i}`, "Labour and migrants", `u${i}`)], trends, NOW);
  }
  reinforceMemory(mem, [c("one", "weather and bins")], trends, NOW);
  expect(mem.edges[edgeKey("labour", "migrants")]!.weight).toBeGreaterThan(
    mem.edges[edgeKey("weather", "bins")]!.weight,
  );
});

test("counts distinct voices, so one ranter can't inflate breadth", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("boats")];
  reinforceMemory(mem, [c("1", "boats", "solo"), c("2", "boats", "solo"), c("3", "boats", "other")], trends, NOW);
  expect(mem.nodes["boats"]!.weight).toBe(3); // three mentions
  expect(mem.nodes["boats"]!.authors).toEqual(["solo", "other"]); // two people
});

test("a lone commenter posting across many batches stays one voice", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("boats")];
  // Comments arrive incrementally, as they do from the live stream.
  reinforceMemory(mem, [c("1", "boats", "solo")], trends, NOW);
  reinforceMemory(mem, [c("2", "boats", "solo")], trends, NOW);
  reinforceMemory(mem, [c("3", "boats", "solo")], trends, NOW);
  expect(mem.nodes["boats"]!.weight).toBe(3); // three mentions accumulate
  expect(memoryToGraph(mem, { minWeight: 0.5 }).nodes[0]?.voices).toBe(1); // but one voice
});

test("remembers one topic per word regardless of casing", () => {
  // The trend detector picks whichever spelling dominated that tick, so the
  // same topic arrives as "stop" one moment and "Stop" the next.
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "stop the boats", "a")], [t("stop")], NOW);
  reinforceMemory(mem, [c("2", "Stop the boats", "b")], [t("Stop")], NOW);

  expect(Object.keys(mem.nodes).filter((k) => k.toLowerCase() === "stop")).toHaveLength(1);
  expect(mem.nodes["stop"]!.weight).toBe(2); // both mentions on one topic
  expect(mem.nodes["stop"]!.label).toBe("Stop"); // and the nicer spelling wins

  const graph = memoryToGraph(mem, { minWeight: 0.5 });
  expect(graph.nodes.filter((n) => n.id === "stop")).toHaveLength(1);
  expect(graph.nodes[0]!.label).toBe("Stop");
});

test("projects to a graph, marking topics not currently trending as faded", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("Labour"), t("migrants")];
  reinforceMemory(mem, [c("1", "Labour and migrants")], trends, NOW);
  const graph = memoryToGraph(mem, { minWeight: 0.5, live: new Set(["labour"]) });
  expect(graph.nodes.find((n) => n.id === "labour")?.weak).toBe(false);
  expect(graph.nodes.find((n) => n.id === "migrants")?.weak).toBe(true);
  expect(graph.links).toHaveLength(1);
});

test("drops links whose endpoints fell out of the top slice", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("Labour"), t("migrants")];
  reinforceMemory(mem, [c("1", "Labour and migrants")], trends, NOW);
  const graph = memoryToGraph(mem, { maxNodes: 1, minWeight: 0.5 });
  expect(graph.nodes).toHaveLength(1);
  expect(graph.links).toHaveLength(0); // no dangling edge
});

test("survives a storage round-trip, and shrugs off junk", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Labour and migrants")], [t("Labour"), t("migrants")], NOW);
  const restored = deserializeMemory(serializeMemory(mem), NOW);
  expect(restored.edges[edgeKey("labour", "migrants")]?.weight).toBe(1);
  expect(deserializeMemory("not json", NOW).nodes).toEqual({});
  expect(deserializeMemory(null, NOW).nodes).toEqual({});
});
