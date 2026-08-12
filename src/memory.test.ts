import { expect, test } from "bun:test";
import {
  canonicalizeTrends,
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

test("folds a bare name into the fuller one remembered separately", () => {
  // The two spellings peaked at different times, so the per-tick trend merge
  // never saw them together and both accumulated in memory.
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Burnham again", "a"), c("2", "Burnham once more", "b")], [t("Burnham")], NOW);
  reinforceMemory(mem, [c("3", "Andy Burnham's speech", "c")], [t("Andy Burnham's")], NOW);

  const ids = Object.keys(mem.nodes);
  expect(ids.filter((id) => id.includes("burnham"))).toHaveLength(1); // one person
  const node = mem.nodes[ids.find((id) => id.includes("burnham"))!]!;
  expect(node.label).toBe("Andy Burnham"); // fuller name, possessive dropped
  expect(node.weight).toBe(2); // carried, not summed — the mentions overlap
  expect([...node.authors].sort()).toEqual(["a", "b", "c"]); // every voice kept
});

test("folds a bare word into the phrase that contains it", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "illegal again", "a")], [t("illegal")], NOW);
  reinforceMemory(mem, [c("2", "illegal migrants here", "b")], [t("illegal migrants")], NOW);

  const ids = Object.keys(mem.nodes);
  expect(ids).toContain("illegal migrants");
  expect(ids).not.toContain("illegal");
});

test("a Title-cased spelling displaces a SHOUTED one, but acronyms stand", () => {
  const mem = emptyMemory(NOW);
  // The room SHOUTS first; the label should still end up readable.
  reinforceMemory(mem, [c("1", "BURNHAM out", "a")], [t("BURNHAM")], NOW);
  expect(mem.nodes["burnham"]!.label).toBe("BURNHAM");
  reinforceMemory(mem, [c("2", "Burnham again", "b")], [t("Burnham")], NOW);
  expect(mem.nodes["burnham"]!.label).toBe("Burnham"); // Title case wins

  // Short all-caps is a genuine acronym — "Uk" must not displace "UK".
  reinforceMemory(mem, [c("3", "UK first", "a")], [t("UK")], NOW);
  reinforceMemory(mem, [c("4", "Uk always", "b")], [t("Uk")], NOW);
  expect(mem.nodes["uk"]!.label).toBe("UK");
});

test("joins two lone words the news cycle knows as one name", () => {
  // "Andy" and "Burnham" trended at different times and never as the phrase,
  // so subset containment can't touch them — only the corpus knows better.
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Andy at it again", "a"), c("2", "Andy always", "b")], [t("Andy")], NOW);
  reinforceMemory(mem, [c("3", "Burnham speech", "x"), c("4", "Burnham nonsense", "y"), c("5", "Burnham again", "z")], [t("Burnham")], NOW);
  expect(Object.keys(mem.nodes).sort()).toEqual(["andy", "burnham"]); // apart without the corpus

  reinforceMemory(mem, [c("6", "nothing new", "q")], [t("Andy")], NOW, {
    knownPhrases: new Set(["andy burnham"]),
  });
  const ids = Object.keys(mem.nodes).filter((id) => id.includes("andy") || id.includes("burnham"));
  expect(ids).toEqual(["andy burnham"]); // one person on the map
  const node = mem.nodes["andy burnham"]!;
  expect(node.label).toBe("Andy Burnham");
  expect([...node.authors].sort()).toEqual(["a", "b", "x", "y", "z"]); // every voice kept
});

test("does not pair words the corpus has no phrase for", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Labour today", "a")], [t("Labour")], NOW);
  reinforceMemory(mem, [c("2", "migrants today", "b")], [t("migrants")], NOW, {
    knownPhrases: new Set(["andy burnham"]), // unrelated phrase
  });
  expect(Object.keys(mem.nodes).sort()).toEqual(["labour", "migrants"]);
});

test("the paired node inherits the pair's edges and drops their mutual link", () => {
  const mem = emptyMemory(NOW);
  // One comment mentions Andy + Labour, another Burnham + Labour: after the
  // pairing, both connections should belong to "andy burnham" — and the
  // andy—burnham edge itself must dissolve rather than become a self-loop.
  reinforceMemory(mem, [c("1", "Andy and Labour", "a")], [t("Andy"), t("Labour")], NOW);
  reinforceMemory(mem, [c("2", "Burnham and Labour and Andy", "b")], [t("Burnham"), t("Labour"), t("Andy")], NOW, {
    knownPhrases: new Set(["andy burnham"]),
  });
  const SEP = String.fromCharCode(31);
  const keys = Object.keys(mem.edges).map((k) => k.split(SEP).sort().join("+"));
  expect(keys).toEqual(["andy burnham+labour"]); // re-pointed, deduped, no self-loop
});

test("leaves genuinely different topics alone", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("Labour"), t("migrants"), t("France")];
  reinforceMemory(
    mem,
    [c("1", "Labour again", "a"), c("2", "migrants here", "b"), c("3", "France next", "c")],
    trends,
    NOW,
  );
  expect(Object.keys(mem.nodes).sort()).toEqual(["france", "labour", "migrants"]);
});

test("re-points edges onto the survivor and drops the self-link", () => {
  const mem = emptyMemory(NOW);
  // "Burnham" is tied to "Labour"; the fuller name arrives later.
  reinforceMemory(mem, [c("1", "Burnham and Labour", "a")], [t("Burnham"), t("Labour")], NOW);
  reinforceMemory(mem, [c("2", "Andy Burnham and Labour", "b")], [t("Andy Burnham"), t("Labour")], NOW);

  const keys = Object.keys(mem.edges);
  expect(keys).toHaveLength(1); // not one edge per spelling
  const [a, b] = keys[0]!.split(String.fromCharCode(31));
  expect([a, b].sort()).toEqual(["andy burnham", "labour"]);
});

test("canonicalizes a fresh short-form trend to the remembered identity", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Andy Burnham speech", "a"), c("2", "Andy Burnham again", "b")], [t("Andy Burnham")], NOW);

  const fresh: Trend = { word: "Burnham", recent: 9, prior: 0, score: 30, authors: 5 };
  const [out] = canonicalizeTrends(mem, [fresh]);
  expect(out!.word).toBe("Andy Burnham"); // the row says what the map says
  expect(out!.recent).toBe(9); // the live count is untouched
  // The pattern still matches the short form, so highlighting and the
  // memory's own reinforcement keep working on comments saying just "Burnham".
  expect(new RegExp(`\\b(?:${out!.pattern})\\b`, "i").test("Burnham is at it")).toBe(true);
});

test("two fresh trends resolving to one person collapse into one chip", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Andy Burnham speech", "a"), c("2", "Andy Burnham twice", "b")], [t("Andy Burnham")], NOW);

  const out = canonicalizeTrends(mem, [
    { word: "Burnham", recent: 9, prior: 0, score: 30, authors: 5 },
    { word: "Andy", recent: 4, prior: 0, score: 12, authors: 3 },
    { word: "Labour", recent: 6, prior: 0, score: 20, authors: 4 },
  ]);
  expect(out.map((t2) => t2.word)).toEqual(["Andy Burnham", "Labour"]);
  expect(out[0]!.recent).toBe(9); // strongest of the collapsed pair
});

test("canonicalization heals a shouted remembered label from live evidence", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Andy BURNHAM rant", "a"), c("2", "Andy BURNHAM more", "b")], [t("Andy BURNHAM")], NOW);
  expect(mem.nodes["andy burnham"]!.label).toBe("Andy BURNHAM");

  canonicalizeTrends(mem, [{ word: "Burnham", recent: 3, prior: 0, score: 10, authors: 2 }]);
  expect(mem.nodes["andy burnham"]!.label).toBe("Andy Burnham"); // word healed
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
