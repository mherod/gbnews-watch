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
  /**
   * Which broadcasts this topic was argued under: decayed reinforcement per
   * programme title, aged exactly like `weight`. The comments carry no
   * timestamps worth trusting for this — attribution happens at learning time,
   * against whatever the schedule says is on air *now*.
   */
  onAir?: Record<string, number>;
}

/** Plenty for sizing; past this the exact number stops meaning anything. */
const MAX_AUTHORS = 16;

/** A topic that outlives this many programmes has stopped being *about* any of them. */
const MAX_PROGRAMMES = 6;

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
  /**
   * Stem-joined phrases known to be real names/topics (from the RSS corpus).
   * Lets consolidation join two single-word topics — "andy" and "burnham" —
   * that never co-trended as a phrase, which subset containment alone can't
   * justify. Identification signal only; nothing from it is rendered.
   */
  knownPhrases?: ReadonlySet<string>;
  /**
   * Title of the programme on air while these comments are being folded in.
   * Every topic reinforced this pass is attributed to it, building a decayed
   * picture of which broadcasts provoke which arguments.
   */
  onAir?: string;
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
    if (n.onAir) {
      for (const [title, w] of Object.entries(n.onAir)) {
        if (w * factor < floor) delete n.onAir[title];
        else n.onAir[title] = w * factor;
      }
      if (Object.keys(n.onAir).length === 0) delete n.onAir;
    }
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
      // Keep the best-cased spelling seen so far. The old rule froze on the
      // first non-lowercase form, so one SHOUTED "BURNHAM" branded the topic
      // "Andy BURNHAM" forever while the trend row showed "Andy Burnham".
      if (!node.label || labelQuality(label) > labelQuality(node.label)) {
        node.label = label;
      }
      node.weight += 1;
      node.lastSeen = now;
      if (opts.onAir) bumpOnAir(node, opts.onAir);
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
  consolidateMemory(mem, opts);
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

/** One more comment argued this topic under the given broadcast. */
function bumpOnAir(node: MemoryNode, title: string): void {
  const buckets = (node.onAir ??= {});
  buckets[title] = (buckets[title] ?? 0) + 1;
  const titles = Object.keys(buckets);
  if (titles.length > MAX_PROGRAMMES) {
    // The faintest attribution goes — never the one just reinforced.
    titles.sort((a, b) => buckets[a]! - buckets[b]!);
    for (const t of titles.slice(0, titles.length - MAX_PROGRAMMES)) delete buckets[t];
  }
}

/**
 * Carries programme attribution across a node merge. Max per title, not sum,
 * for the same reason weight merges as max: the variants counted the same
 * comments, so adding their buckets would double the evidence.
 */
function mergeOnAir(dst: MemoryNode, src: MemoryNode): void {
  if (!src.onAir) return;
  const buckets = (dst.onAir ??= {});
  for (const [title, w] of Object.entries(src.onAir)) {
    buckets[title] = Math.max(buckets[title] ?? 0, w);
  }
}

/**
 * How readable a spelling is, per word: Title case scores highest, SHOUTING
 * and lowercase below it — except short all-caps words, which are almost
 * always genuine acronyms (UK, NHS, UKIP) and rank alongside Title case so a
 * stray "Uk" can never displace them. Averaged so word count doesn't matter.
 */
function labelQuality(label: string): number {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let score = 0;
  for (const w of words) {
    const first = w[0]!;
    const capFirst = first !== first.toLowerCase();
    if (!capFirst) continue; // lowercase: 0
    if (w !== w.toUpperCase()) score += 2; // Title case
    else score += w.length <= 4 ? 2 : 1; // acronym vs SHOUTING
  }
  return score / words.length;
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
export function consolidateMemory(mem: TopicMemory, opts: MemoryOptions = {}): TopicMemory {
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
  if (target.size === 0) return pairKnownPhrases(mem, opts);

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
    mergeOnAir(dst, src);
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

  return pairKnownPhrases(mem, opts);
}

/**
 * Joins two single-word topics the news cycle knows as one name. Subset
 * containment can never merge "andy" and "burnham" — neither contains the
 * other — but a corpus phrase "andy burnham" is outside evidence that they are
 * one person, so the pair becomes the phrase node the map should be showing.
 * Weight is carried as a max (the same comment often mentioned both words) and
 * their mutual edge dissolves into the merged body.
 */
function pairKnownPhrases(mem: TopicMemory, opts: MemoryOptions): TopicMemory {
  const phrases = opts.knownPhrases;
  if (!phrases || phrases.size === 0) return mem;

  // Lone-word topics only; multi-word nodes already carry their own identity.
  const stemOf = new Map<string, string>();
  for (const id of Object.keys(mem.nodes)) {
    const t = topicTokens(mem.nodes[id]!.label ?? id);
    if (t.size === 1) stemOf.set(id, [...t][0]!);
  }
  if (stemOf.size < 2) return mem;

  const redirect = new Map<string, string>();
  const singles = [...stemOf.keys()].sort(); // stable pairing order
  for (const a of singles) {
    if (redirect.has(a) || !mem.nodes[a]) continue;
    for (const b of singles) {
      if (a === b || redirect.has(b) || !mem.nodes[b]) continue;
      const phraseId = `${stemOf.get(a)!} ${stemOf.get(b)!}`;
      if (!phrases.has(phraseId)) continue;

      const na = mem.nodes[a]!;
      const nb = mem.nodes[b]!;
      const joined = prettyLabel(`${na.label ?? a} ${nb.label ?? b}`);
      const dst = (mem.nodes[phraseId] ??= {
        label: joined,
        weight: 0,
        authors: [],
        sentSum: 0,
        sentCount: 0,
        lastSeen: 0,
      });
      if (labelQuality(joined) > labelQuality(dst.label ?? phraseId)) dst.label = joined;
      dst.weight = Math.max(dst.weight, na.weight, nb.weight);
      dst.sentSum += na.sentSum + nb.sentSum;
      dst.sentCount += na.sentCount + nb.sentCount;
      dst.lastSeen = Math.max(dst.lastSeen, na.lastSeen, nb.lastSeen);
      mergeOnAir(dst, na);
      mergeOnAir(dst, nb);
      for (const author of [...na.authors, ...nb.authors]) {
        if (dst.authors.length >= MAX_AUTHORS) break;
        if (!dst.authors.includes(author)) dst.authors.push(author);
      }
      delete mem.nodes[a];
      delete mem.nodes[b];
      redirect.set(a, phraseId);
      redirect.set(b, phraseId);
      break;
    }
  }
  if (redirect.size === 0) return mem;

  for (const key of Object.keys(mem.edges)) {
    const [a, b] = edgeEnds(key);
    const ra = redirect.get(a) ?? a;
    const rb = redirect.get(b) ?? b;
    if (ra === a && rb === b) continue;
    const edge = mem.edges[key]!;
    delete mem.edges[key];
    if (ra === rb) continue; // the pair's own link dissolves into the merged body
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
    onAir: topProgrammes(n),
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

/**
 * A node's programme attribution as the graph wants it: strongest first, as
 * shares of the topic's total attributed weight — "74% of this argument
 * happened during X" survives decay, absolute bucket numbers don't mean much.
 */
function topProgrammes(n: MemoryNode): TopicNode["onAir"] {
  if (!n.onAir) return undefined;
  const entries = Object.entries(n.onAir);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return undefined;
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([title, w]) => ({ title, share: w / total }));
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Gives live trends the identity the memory has already worked out, so the
 * trend row and the map tell one story. A fresh tick that only saw "Burnham"
 * is relabelled "Andy Burnham" when the memory holds that consolidated topic —
 * and two fresh trends resolving to the same person collapse into one chip.
 *
 * The relabelled trend keeps a pattern that still matches its short form:
 * highlighting, filtering and — critically — the memory's own reinforcement
 * must keep matching comments that just say "Burnham", or the consolidated
 * topic would starve and decay while it is at its hottest.
 *
 * As a side effect, a better-cased fresh word heals the remembered label
 * word-by-word, so a "BURNHAM" shouted into the memory recovers to "Burnham"
 * from live Title-cased evidence.
 */
export function canonicalizeTrends(mem: TopicMemory, trends: readonly Trend[]): Trend[] {
  const ids = Object.keys(mem.nodes);
  if (ids.length === 0 || trends.length === 0) return [...trends];

  const nodeTokens = new Map(ids.map((id) => [id, topicTokens(mem.nodes[id]!.label ?? id)]));
  const byNode = new Map<string, Trend>();
  const out: Trend[] = [];

  for (const t of trends) {
    const tt = topicTokens(t.word);
    let best: string | null = null;
    if (tt.size > 0) {
      for (const id of ids) {
        const nt = nodeTokens.get(id)!;
        if (nt.size <= tt.size || !isSubset(tt, nt)) continue;
        // Smallest strict superset wins; weight settles ties deterministically.
        if (
          best === null ||
          nt.size < nodeTokens.get(best)!.size ||
          (nt.size === nodeTokens.get(best)!.size && mem.nodes[id]!.weight > mem.nodes[best]!.weight)
        ) {
          best = id;
        }
      }
    }
    if (best === null) {
      out.push(t);
      continue;
    }

    const node = mem.nodes[best]!;
    // Heal the remembered casing from live evidence, word by word.
    if (node.label) {
      node.label = node.label
        .split(/\s+/)
        .map((w) => {
          if (normalize(w) !== normalize(t.word) || t.word.includes(" ")) return w;
          return labelQuality(t.word) > labelQuality(w) ? t.word : w;
        })
        .join(" ");
    }

    const word = prettyLabel(node.label ?? best);
    const pattern = [t.pattern ?? escapeRegex(t.word.toLowerCase()), escapeRegex(word.toLowerCase())].join("|");
    const existing = byNode.get(best);
    if (existing) {
      // Two fresh trends resolved to the same topic — one chip, not two.
      existing.recent = Math.max(existing.recent, t.recent);
      existing.score = Math.max(existing.score, t.score);
      existing.authors = Math.max(existing.authors ?? 0, t.authors ?? 0);
      existing.pattern = [existing.pattern, escapeRegex(t.word.toLowerCase())].filter(Boolean).join("|");
      if (t.weak === false || existing.weak === false) existing.weak = undefined;
      continue;
    }
    const canonical: Trend = { ...t, word, pattern };
    byNode.set(best, canonical);
    out.push(canonical);
  }

  return out;
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
