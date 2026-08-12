/**
 * A long-lived association memory for the topic map.
 *
 * The window-based graph in `graph.ts` is amnesiac: every recalculation rebuilds
 * from the last few minutes, so a pair of topics argued together all evening
 * looks exactly like a pair argued together once. This module keeps the
 * association instead of severing it — each comment *reinforces* the links it
 * contains, and everything decays exponentially with a half-life, so the map
 * reflects what this audience persistently connects while still letting go of
 * what has genuinely moved on.
 *
 * Reinforcement + decay (rather than a rolling window) means the graph is
 * always learning: a link seen once an hour survives, a link seen once ever
 * fades out, and a link hammered repeatedly becomes structural.
 *
 * Pure and storage-free — the caller owns persistence.
 */

import { scoreText } from "./sentiment";
import { normalize, STOPWORDS, termRegex, type Trend } from "./trending";
import type { TopicGraph, TopicNode, TopicLink } from "./graph";

export interface MemoryNode {
  /**
   * Nicest spelling seen for this topic. Nodes are keyed case-folded, because
   * the trend detector picks whichever casing was most common that tick — so
   * "stop" and "Stop" arrived as two separate remembered topics.
   */
  label?: string;
  /** Decayed reinforcement — how much this topic has mattered lately. */
  weight: number;
  /**
   * Distinct people who have raised it, kept as ids rather than a counter:
   * comments arrive incrementally, so a running total would credit the same
   * commenter again on every batch and turn one obsessive into a crowd.
   * Capped — beyond a handful, "lots of people" is the only signal that matters.
   */
  authors: string[];
  sentSum: number;
  sentCount: number;
  lastSeen: number;
}

/** Plenty for sizing; past this the exact number stops meaning anything. */
const MAX_AUTHORS = 16;

export interface MemoryEdge {
  weight: number;
  lastSeen: number;
}

export interface TopicMemory {
  nodes: Record<string, MemoryNode>;
  /** Keyed by `edgeKey(a, b)`. */
  edges: Record<string, MemoryEdge>;
  /** Comment ids already folded in, so re-renders never double-count. */
  seen: string[];
  /** When the weights were last decayed. */
  decayedAt: number;
}

export interface MemoryInput {
  id: string;
  body: string;
  postedAt: string;
  author?: string;
}

export interface MemoryOptions {
  /** Time for a weight to halve. Long enough to span ad breaks and lulls. */
  halfLifeMs?: number;
  /** Weights below this are forgotten entirely. */
  floor?: number;
  /** Cap on remembered comment ids. */
  maxSeen?: number;
  maxNodes?: number;
  maxEdges?: number;
}

const HALF_LIFE_MS = 45 * 60_000;
const FLOOR = 0.05;
const MAX_SEEN = 600;
const MAX_NODES = 90;
const MAX_EDGES = 300;

/**
 * Separator for edge keys. Explicit (and exported with `edgeKey`) because
 * topics can themselves contain spaces — "Matthew Stadlen", "stop the boats" —
 * so a space would make the key ambiguous to split back apart.
 */
const SEP = String.fromCharCode(31); // ASCII unit separator; topics contain spaces, so a space would be ambiguous

export function emptyMemory(now = 0): TopicMemory {
  return { nodes: {}, edges: {}, seen: [], decayedAt: now };
}

/** Stable, order-independent key for the link between two topics. */
export function edgeKey(a: string, b: string): string {
  return a < b ? a + SEP + b : b + SEP + a;
}

/** Splits an edge key back into its two topics. */
export function edgeEnds(key: string): [string, string] {
  const i = key.indexOf(SEP);
  return [key.slice(0, i), key.slice(i + 1)];
}

/**
 * Ages every weight toward zero. Called before reinforcement so new evidence is
 * always measured against a fairly-aged past.
 */
export function decayMemory(mem: TopicMemory, now: number, opts: MemoryOptions = {}): TopicMemory {
  const halfLife = opts.halfLifeMs ?? HALF_LIFE_MS;
  const floor = opts.floor ?? FLOOR;
  const elapsed = now - mem.decayedAt;
  if (elapsed <= 0) return mem;

  const factor = Math.pow(0.5, elapsed / halfLife);
  for (const [id, n] of Object.entries(mem.nodes)) {
    n.weight *= factor;
    n.sentCount *= factor;
    n.sentSum *= factor;
    if (n.weight < floor) delete mem.nodes[id];
  }
  for (const [key, e] of Object.entries(mem.edges)) {
    e.weight *= factor;
    if (e.weight < floor) delete mem.edges[key];
  }
  mem.decayedAt = now;
  return mem;
}

/**
 * Folds any comments not yet seen into the memory: each topic present gains
 * weight, and every pair argued in the same comment strengthens its link.
 * Returns the same (mutated) memory for convenience.
 */
export function reinforceMemory(
  mem: TopicMemory,
  comments: readonly MemoryInput[],
  trends: readonly Trend[],
  now: number,
  opts: MemoryOptions = {},
): TopicMemory {
  decayMemory(mem, now, opts);
  if (trends.length === 0) return mem;

  const maxSeen = opts.maxSeen ?? MAX_SEEN;
  const seen = new Set(mem.seen);
  const matchers = trends.map((t) => ({ label: t.word, re: termRegex(t.word, t.pattern) }));

  for (const c of comments) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    mem.seen.push(c.id);

    const hits = matchers.filter((m) => m.re.test(c.body)).map((m) => m.label);
    if (hits.length === 0) continue;
    const mood = scoreText(c.body);

    for (const label of hits) {
      const id = label.toLowerCase();
      const node = (mem.nodes[id] ??= {
        label,
        weight: 0,
        authors: [],
        sentSum: 0,
        sentCount: 0,
        lastSeen: now,
      });
      // Prefer the capitalised spelling ("Stop" over "stop") once it appears —
      // proper nouns and acronyms read better on the map.
      if (!node.label || (label !== label.toLowerCase() && node.label === node.label.toLowerCase())) {
        node.label = label;
      }
      node.weight += 1;
      node.lastSeen = now;
      if (mood !== null) {
        node.sentSum += mood;
        node.sentCount += 1;
      }
      // Breadth is measured against everyone ever seen on this topic, not just
      // this batch, so one commenter posting all evening stays one voice.
      const author = c.author ?? "";
      if (node.authors.length < MAX_AUTHORS && !node.authors.includes(author)) {
        node.authors.push(author);
      }
    }

    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) {
        const key = edgeKey(hits[i]!.toLowerCase(), hits[j]!.toLowerCase());
        const edge = (mem.edges[key] ??= { weight: 0, lastSeen: now });
        edge.weight += 1;
        edge.lastSeen = now;
      }
    }
  }

  if (mem.seen.length > maxSeen) mem.seen = mem.seen.slice(-maxSeen);
  consolidateMemory(mem);
  prune(mem, opts);
  return mem;
}

const WORD = /[\p{L}][\p{L}\p{N}'']*/gu;

/** The content words a topic is really made of — casing, possessives, plurals
 *  and filler words removed, so "Andy Burnham's" and "Burnham" can be compared. */
function topicTokens(label: string): Set<string> {
  const out = new Set<string>();
  for (const m of label.matchAll(WORD)) {
    const stem = normalize(m[0]);
    if (stem.length >= 3 && !STOPWORDS.has(stem)) out.add(stem);
  }
  return out;
}

/** Display form: drop a trailing possessive so a chip reads "Andy Burnham". */
function prettyLabel(label: string): string {
  return label.replace(/['']s$/, "");
}

const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((t) => b.has(t));

/**
 * Folds variant spellings of one topic together.
 *
 * The per-tick trend merge only ever sees the topics detected in that tick, so
 * two spellings that peaked at different times — "Burnham" this evening,
 * "Andy Burnham's" an hour ago — accumulate as separate remembered topics and
 * appear on the map as two bodies for one person.
 *
 * A topic folds into another when its content words are a subset of the
 * other's ("burnham" ⊂ "andy burnham"), or when both reduce to the same words
 * and one is simply the tidier spelling. The fuller label wins, and weight is
 * carried across rather than summed: a comment saying "Andy Burnham" was
 * already counted under "Burnham" too, so adding them would double count.
 */
export function consolidateMemory(mem: TopicMemory): TopicMemory {
  const ids = Object.keys(mem.nodes);
  if (ids.length < 2) return mem;

  const tokens = new Map(ids.map((id) => [id, topicTokens(mem.nodes[id]!.label ?? id)]));
  // Higher rank absorbs lower: heavier first, then the fuller label, then id
  // order so the choice is stable and two nodes can never absorb each other.
  const rank = (id: string): [number, number, string] => [
    mem.nodes[id]!.weight,
    tokens.get(id)!.size,
    id,
  ];
  const outranks = (a: string, b: string) => {
    const [aw, at, ai] = rank(a);
    const [bw, bt, bi] = rank(b);
    if (aw !== bw) return aw > bw;
    if (at !== bt) return at > bt;
    return ai < bi;
  };

  const target = new Map<string, string>();
  for (const a of ids) {
    const ta = tokens.get(a)!;
    if (ta.size === 0) continue;
    let best: string | null = null;
    for (const b of ids) {
      if (a === b) continue;
      const tb = tokens.get(b)!;
      if (!isSubset(ta, tb)) continue;
      // Same words: only the tidier/heavier spelling survives. Strict subset:
      // the longer phrase always wins, however small it is.
      if (tb.size === ta.size && !outranks(b, a)) continue;
      if (best === null || outranks(b, best)) best = b;
    }
    if (best !== null) target.set(a, best);
  }
  if (target.size === 0) return mem;

  // Follow chains ("burnham" → "andy burnham" → "andy burnham speech") to the
  // final survivor, guarding against a cycle the ranking should already prevent.
  const resolve = (id: string): string => {
    const seen = new Set<string>([id]);
    let cur = id;
    while (target.has(cur)) {
      const next = target.get(cur)!;
      if (seen.has(next)) break;
      seen.add(next);
      cur = next;
    }
    return cur;
  };

  for (const [from] of target) {
    const to = resolve(from);
    if (to === from) continue;
    const src = mem.nodes[from];
    const dst = mem.nodes[to];
    if (!src || !dst) continue;

    dst.weight = Math.max(dst.weight, src.weight);
    dst.sentSum += src.sentSum;
    dst.sentCount += src.sentCount;
    dst.lastSeen = Math.max(dst.lastSeen, src.lastSeen);
    for (const author of src.authors) {
      if (dst.authors.length >= MAX_AUTHORS) break;
      if (!dst.authors.includes(author)) dst.authors.push(author);
    }
    dst.label = prettyLabel(dst.label ?? to);
    delete mem.nodes[from];
  }

  // Re-point every edge at the survivors, dropping links a topic now has to
  // itself, and keeping the strongest weight where two edges collapse into one.
  for (const key of Object.keys(mem.edges)) {
    const [a, b] = edgeEnds(key);
    const ra = resolve(a);
    const rb = resolve(b);
    if (ra === a && rb === b) continue;
    const edge = mem.edges[key]!;
    delete mem.edges[key];
    if (ra === rb) continue; // the pair became one topic
    const merged = edgeKey(ra, rb);
    const existing = mem.edges[merged];
    mem.edges[merged] = existing
      ? { weight: Math.max(existing.weight, edge.weight), lastSeen: Math.max(existing.lastSeen, edge.lastSeen) }
      : edge;
  }

  return mem;
}

/** Keeps the memory bounded: strongest nodes and edges win. */
export function prune(mem: TopicMemory, opts: MemoryOptions = {}): TopicMemory {
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const maxEdges = opts.maxEdges ?? MAX_EDGES;

  const nodeIds = Object.keys(mem.nodes);
  if (nodeIds.length > maxNodes) {
    const keep = new Set(
      nodeIds.sort((a, b) => mem.nodes[b]!.weight - mem.nodes[a]!.weight).slice(0, maxNodes),
    );
    for (const id of nodeIds) if (!keep.has(id)) delete mem.nodes[id];
  }
  // Drop edges whose endpoints are gone, then cap by strength.
  for (const key of Object.keys(mem.edges)) {
    const [a, b] = edgeEnds(key);
    if (!mem.nodes[a] || !mem.nodes[b]) delete mem.edges[key];
  }
  const edgeKeys = Object.keys(mem.edges);
  if (edgeKeys.length > maxEdges) {
    const keep = new Set(
      edgeKeys.sort((a, b) => mem.edges[b]!.weight - mem.edges[a]!.weight).slice(0, maxEdges),
    );
    for (const key of edgeKeys) if (!keep.has(key)) delete mem.edges[key];
  }
  return mem;
}

/**
 * Projects the memory into the graph the constellation draws. `live` marks the
 * topics currently trending so the map can show what's hot *now* against the
 * associations it has learned over time.
 */
export function memoryToGraph(
  mem: TopicMemory,
  opts: { maxNodes?: number; minWeight?: number; live?: ReadonlySet<string> } = {},
): TopicGraph {
  const maxNodes = opts.maxNodes ?? 14;
  const minWeight = opts.minWeight ?? 0.6;
  const live = opts.live;

  const ranked = Object.entries(mem.nodes)
    .filter(([, n]) => n.weight >= minWeight)
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, maxNodes);
  const present = new Set(ranked.map(([id]) => id));

  const nodes: TopicNode[] = ranked.map(([id, n]) => ({
    id,
    label: n.label ?? id,
    voices: Math.max(1, n.authors?.length ?? 1),
    mentions: Math.round(n.weight),
    sentiment: n.sentCount >= 0.5 ? n.sentSum / n.sentCount : null,
    // "Weak" now means faded from the live conversation, not merely single-voice.
    weak: live ? !live.has(id.toLowerCase()) : false,
  }));

  const links: TopicLink[] = Object.entries(mem.edges)
    .map(([key, e]) => {
      const [source, target] = edgeEnds(key);
      return { source, target, weight: e.weight };
    })
    .filter((l) => present.has(l.source) && present.has(l.target))
    .sort((a, b) => b.weight - a.weight);

  return { nodes, links };
}

/** Round-trips the memory through storage, tolerating anything malformed. */
export function serializeMemory(mem: TopicMemory): string {
  return JSON.stringify(mem);
}

export function deserializeMemory(raw: string | null, now: number): TopicMemory {
  if (!raw) return emptyMemory(now);
  try {
    const parsed = JSON.parse(raw) as Partial<TopicMemory>;
    if (!parsed || typeof parsed !== "object" || !parsed.nodes || !parsed.edges) return emptyMemory(now);
    return {
      nodes: parsed.nodes,
      edges: parsed.edges,
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      decayedAt: typeof parsed.decayedAt === "number" ? parsed.decayedAt : now,
    };
  } catch {
    return emptyMemory(now);
  }
}
