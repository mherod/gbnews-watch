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

  reinforceMemory(mem, [c("2", "migrants, blame Labour", "b")], trends, NOW);
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
  reinforceMemory(
    mem,
    [c("1", "boats", "solo"), c("2", "boats again", "solo"), c("3", "the boats", "other")],
    trends,
    NOW,
  );
  // solo's second mention is a warm repeat (¼); other's fresh words count full.
  expect(mem.nodes["boats"]!.weight).toBeCloseTo(2.25, 5);
  expect(mem.nodes["boats"]!.authors).toEqual(["solo", "other"]); // two people
});

test("a lone commenter posting across many batches stays one voice", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("boats")];
  // Comments arrive incrementally, as they do from the live stream.
  reinforceMemory(mem, [c("1", "boats", "solo")], trends, NOW);
  reinforceMemory(mem, [c("2", "boats again", "solo")], trends, NOW);
  reinforceMemory(mem, [c("3", "more boats", "solo")], trends, NOW);
  // Mentions keep accumulating, but a voice the topic already counted only
  // keeps it warm (¼ each) rather than stacking full weight.
  expect(mem.nodes["boats"]!.weight).toBeCloseTo(1.5, 5);
  expect(memoryToGraph(mem, { minWeight: 0.5 }).nodes[0]?.voices).toBe(1); // one voice
});

test("remembers one topic per word regardless of casing", () => {
  // The trend detector picks whichever spelling dominated that tick, so the
  // same topic arrives as "stop" one moment and "Stop" the next.
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "stop the boats", "a")], [t("stop")], NOW);
  reinforceMemory(mem, [c("2", "Stop the boats now", "b")], [t("Stop")], NOW);

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

test("attributes reinforcement to the programme on air, decaying like everything else", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("boats")];
  reinforceMemory(mem, [c("1", "boats", "a"), c("2", "boats again", "b")], trends, NOW, { onAir: "Breakfast" });
  reinforceMemory(mem, [c("3", "boats still", "d")], trends, NOW + MIN, { onAir: "Patrick Christys" });

  const buckets = mem.nodes["boats"]!.onAir!;
  expect(buckets["Breakfast"]).toBeCloseTo(2, 1); // two comments under Breakfast
  expect(buckets["Patrick Christys"]).toBe(1);

  // A full half-life later the attribution has aged exactly like the weight.
  decayMemory(mem, NOW + MIN + 45 * MIN, { halfLifeMs: 45 * MIN });
  expect(mem.nodes["boats"]!.onAir!["Patrick Christys"]).toBeCloseTo(0.5, 5);

  // And long after, the buckets are forgotten with everything else.
  decayMemory(mem, NOW + 8 * 60 * MIN, { halfLifeMs: 45 * MIN });
  expect(mem.nodes["boats"]?.onAir).toBeUndefined();
});

test("a topic without a schedule learns no attribution at all", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "boats")], [t("boats")], NOW); // no onAir known
  expect(mem.nodes["boats"]!.onAir).toBeUndefined();
});

test("programme attribution survives a consolidation fold", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Burnham again", "a")], [t("Burnham")], NOW, { onAir: "Headliners" });
  reinforceMemory(mem, [c("2", "Andy Burnham's speech", "b")], [t("Andy Burnham's")], NOW, { onAir: "Breakfast" });

  const id = Object.keys(mem.nodes).find((k) => k.includes("burnham"))!;
  const buckets = mem.nodes[id]!.onAir!;
  // The fold carried both variants' attributions onto the surviving person.
  expect(buckets["Headliners"]).toBe(1);
  expect(buckets["Breakfast"]).toBe(1);
});

test("projects programme shares onto graph nodes, strongest first", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("boats")];
  for (let i = 0; i < 3; i++) reinforceMemory(mem, [c(`b${i}`, `boats ${i}`, `u${i}`)], trends, NOW, { onAir: "Breakfast" });
  reinforceMemory(mem, [c("p", "boats still", "u9")], trends, NOW, { onAir: "Patrick Christys" });

  const node = memoryToGraph(mem, { minWeight: 0.5 }).nodes[0]!;
  expect(node.onAir?.map((p) => p.title)).toEqual(["Breakfast", "Patrick Christys"]);
  expect(node.onAir![0]!.share).toBeCloseTo(0.75, 5); // 3 of 4 attributed comments
  expect(node.onAir!.reduce((sum, p) => sum + p.share, 0)).toBeCloseTo(1, 5);
});

test("only a handful of programmes are remembered per topic", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("boats")];
  for (let i = 0; i < 9; i++) {
    reinforceMemory(mem, [c(`s${i}`, `boats ${i}`, `u${i}`)], trends, NOW, { onAir: `Show ${i}` });
  }
  const buckets = mem.nodes["boats"]!.onAir!;
  expect(Object.keys(buckets).length).toBeLessThanOrEqual(6);
  expect(buckets["Show 8"]).toBe(1); // the freshest attribution is never the one dropped
});

test("a fold never carries more programme attributions than the cap", () => {
  const mem = emptyMemory(NOW);
  // Two lone words the corpus knows as one name. Neither's tokens contain the
  // other's, so subset consolidation never touches them — each accumulates its
  // own broadcasts until the pairing sweep joins them in one step.
  for (let i = 0; i < 5; i++) {
    reinforceMemory(mem, [c(`a${i}`, "andy", `ua${i}`)], [t("andy")], NOW, { onAir: `A ${i}` });
    reinforceMemory(mem, [c(`b${i}`, "burnham", `ub${i}`)], [t("burnham")], NOW, { onAir: `B ${i}` });
  }
  // One show is argued under twice — the strongest attribution on either side.
  reinforceMemory(mem, [c("x", "andy again", "ux")], [t("andy")], NOW, { onAir: "A 0" });
  expect(Object.keys(mem.nodes["andy"]!.onAir!)).toHaveLength(5);
  expect(Object.keys(mem.nodes["burnham"]!.onAir!)).toHaveLength(5);

  // The pairing fold unions both sides' buckets: ten candidates, six slots.
  reinforceMemory(mem, [c("p", "boats", "up")], [t("boats")], NOW, {
    knownPhrases: new Set(["andy burnham"]),
  });
  const buckets = mem.nodes["andy burnham"]!.onAir!;
  expect(Object.keys(buckets).length).toBeLessThanOrEqual(6);
  expect(buckets["A 0"]).toBe(2); // the strongest survives the trim
});

// --- typo folding ----------------------------------------------------------

test("a misspelt topic folds into the spelling already remembered", () => {
  const mem = emptyMemory(NOW);
  // The room establishes the real thing first.
  reinforceMemory(mem, [c("1", "Oxford University again", "a")], [t("Oxford University")], NOW);
  reinforceMemory(mem, [c("2", "Oxford University sneers", "b")], [t("Oxford University")], NOW);
  // Then somebody fat-fingers it.
  reinforceMemory(mem, [c("3", "Oxford Univerity types", "c")], [t("Oxford Univerity")], NOW);

  expect(mem.nodes["oxford univerity"]).toBeUndefined(); // no twin
  expect(mem.nodes["oxford university"]!.weight).toBe(3); // the typo reinforced it
  expect(mem.nodes["oxford university"]!.label).toBe("Oxford University"); // and never renamed it
});

test("folds a single-word slip in either direction of length", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Leeds again", "a")], [t("Leeds")], NOW);
  reinforceMemory(mem, [c("2", "Leed again", "b")], [t("Leed")], NOW); // dropped letter
  expect(mem.nodes["leed"]).toBeUndefined();
  expect(mem.nodes["leeds"]!.weight).toBe(2);

  const mem2 = emptyMemory(NOW);
  reinforceMemory(mem2, [c("1", "Labour did it", "a")], [t("Labour")], NOW);
  reinforceMemory(mem2, [c("2", "Labout did it", "b")], [t("Labout")], NOW); // wrong letter
  expect(mem2.nodes["labout"]).toBeUndefined();
  expect(mem2.nodes["labour"]!.weight).toBe(2);
});

test("keeps genuinely different short words apart", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Hope springs", "a")], [t("Hope")], NOW);
  reinforceMemory(mem, [c("2", "Hume wrote", "b")], [t("Hume")], NOW);
  // Two edits apart on a four-letter word — far too loose to call a typo.
  expect(mem.nodes["hope"]!.weight).toBe(1);
  expect(mem.nodes["hume"]!.weight).toBe(1);
});

test("never folds two words the entity corpus both recognises", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Iran again", "a")], [t("Iran")], NOW);
  reinforceMemory(mem, [c("2", "Iraq again", "b")], [t("Iraq")], NOW);
  // One edit apart, but both are real countries.
  expect(mem.nodes["iran"]!.weight).toBe(1);
  expect(mem.nodes["iraq"]!.weight).toBe(1);
});

test("folds a slip in one word of a phrase (the 'hrd left' case)", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "the hard left again", "a")], [t("hard left")], NOW);
  reinforceMemory(mem, [c("2", "the hrd left again", "b")], [t("hrd left")], NOW);
  expect(mem.nodes["hrd left"]).toBeUndefined();
  expect(mem.nodes["hard left"]!.weight).toBe(2);
});

test("never folds across a differing word count", () => {
  // One character apart, but one is a phrase and the other a single word —
  // and no token is a subset of the other, so the pairing fold stays out of it
  // too. Only the typo fold could merge these, and it must not.
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "the hard left again", "a")], [t("hard left")], NOW);
  reinforceMemory(mem, [c("2", "the hardleft again", "b")], [t("hardleft")], NOW);
  expect(mem.nodes["hard left"]!.weight).toBe(1);
  expect(mem.nodes["hardleft"]!.weight).toBe(1);
});

test("a folded typo contributes its edges to the topic it joined", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Labour and migrants", "a")], [t("Labour"), t("migrants")], NOW);
  reinforceMemory(mem, [c("2", "Labout and migrants", "b")], [t("Labout"), t("migrants")], NOW);
  expect(mem.edges[edgeKey("labour", "migrants")]?.weight).toBe(2);
  expect(mem.edges[edgeKey("labout", "migrants")]).toBeUndefined();
});

test("a digit difference is content, not a typo — Channel 5 stays whole", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Channel 4 again", "a")], [t("Channel 4")], NOW);
  reinforceMemory(mem, [c("2", "Channel 5 tonight", "b")], [t("Channel 5")], NOW);
  // One keystroke apart, but two broadcasters: the typo fold must refuse, and
  // digit-aware topic tokens ({channel,4} vs {channel,5}) block consolidation.
  expect(mem.nodes["channel 4"]!.weight).toBe(1);
  expect(mem.nodes["channel 5"]!.weight).toBe(1);
});

// --- copypasta damping -----------------------------------------------------

test("a copy-pasted rant reinforces at a fraction however many socks post it", () => {
  const mem = emptyMemory(NOW);
  const rant = "the Fabian Society is pure evil";
  const trends = [t("Fabian Society")];
  // Observed live: one rant under ~50 generated-name accounts pegged a dozen
  // topics at 47–90 weight while organic multi-voice topics sat under 7.
  for (let i = 0; i < 9; i++) {
    reinforceMemory(mem, [c(`s${i}`, rant, `sock${i}`)], trends, NOW);
  }
  const node = mem.nodes["fabian society"]!;
  expect(node.weight).toBeCloseTo(1 + 8 * 0.25, 5); // 3, not 9
  expect(node.authors).toHaveLength(1); // reposted words are one voice, not a crowd
});

test("distinct voices with their own words still accumulate in full", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("boats")];
  reinforceMemory(
    mem,
    [c("1", "boats again in Dover", "a"), c("2", "the boats keep coming", "b"), c("3", "stop the boats now", "d")],
    trends,
    NOW,
  );
  expect(mem.nodes["boats"]!.weight).toBe(3);
  expect(mem.nodes["boats"]!.authors).toHaveLength(3);
});

test("copypasta damping carries to the edges it argues", () => {
  const mem = emptyMemory(NOW);
  const trends = [t("Labour"), t("migrants")];
  const rant = "Labour and migrants ruined it";
  for (let i = 0; i < 5; i++) reinforceMemory(mem, [c(`s${i}`, rant, `sock${i}`)], trends, NOW);
  expect(mem.edges[edgeKey("labour", "migrants")]!.weight).toBeCloseTo(2, 5); // 1 + 4×¼
});

test("an edge steps at the pace of its more-saturated end", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "boats again", "solo")], [t("boats")], NOW);
  // solo is now a known voice on boats but new to bins: a fresh comment
  // arguing both thickens the tether at the warm quarter-step only.
  reinforceMemory(mem, [c("2", "boats and bins", "solo")], [t("boats"), t("bins")], NOW);
  expect(mem.nodes["bins"]!.weight).toBe(1); // the fresh end counts in full
  expect(mem.edges[edgeKey("boats", "bins")]!.weight).toBeCloseTo(0.25, 5);
});

test("a comment matching a topic twice (typo + canonical) counts it once", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "Oxford University wins", "a")], [t("Oxford University")], NOW);
  // Both spellings trend at once and one comment quotes both; the typo
  // resolves onto the established node, which must not read the second hit
  // as a self-repeat and quarter-step its own edges.
  reinforceMemory(
    mem,
    [c("2", "Oxford Univerity and Oxford University with migrants", "b")],
    [t("Oxford University"), t("Oxford Univerity"), t("migrants")],
    NOW,
  );
  expect(mem.nodes["oxford university"]!.weight).toBe(2); // 1 + 1, not 1 + 1.25
  expect(mem.edges[edgeKey("oxford university", "migrants")]!.weight).toBe(1);
});

test("the bodies ledger survives storage, so a restart still knows the rant", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(mem, [c("1", "boats again", "a")], [t("boats")], NOW);
  const restored = deserializeMemory(serializeMemory(mem), NOW);
  reinforceMemory(restored, [c("2", "boats again", "b")], [t("boats")], NOW);
  expect(restored.nodes["boats"]!.weight).toBeCloseTo(1.25, 5); // repost recognised after reload
});

test("canonicalization never rides a shared word across a digit difference", () => {
  const mem = emptyMemory(NOW);
  reinforceMemory(
    mem,
    [c("1", "Saturday Roast fans", "a"), c("2", "Saturday Roast encore", "b")],
    [t("Saturday Roast")],
    NOW,
  );
  // Digit-blind tokens reduced "Saturday 5" to {saturday} — a subset of the
  // remembered {saturday, roast} — and the fresh chip was relabelled wrongly.
  const [out] = canonicalizeTrends(mem, [{ word: "Saturday 5", recent: 4, prior: 0, score: 12, authors: 3 }]);
  expect(out!.word).toBe("Saturday 5");
});
