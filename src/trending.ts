/**
 * Surfacing words and two-word phrases that are surging in the live comment
 * stream. Pure and framework-free so it can be unit-tested; the UI calls
 * `computeTrends` on a short interval.
 */

export const STOPWORDS = new Set(
  ("the a an and or but if then than that this these those they them their there here "
    + "you your yours we our ours us he she him her his it its i me my mine "
    + "is are was were be been being am do does did doing have has had having "
    + "will would can could should shall may might must of to in on at by for with "
    + "from into over under out up down off about as so not no yes just like get got "
    + "one two all any some more most much many very too also even still now then when "
    + "what who whom which why how where whose because while after before again once "
    + "he's she's it's i'm you're they're we're don't didn't doesn't isn't aren't wasn't "
    + "can't won't wouldn't couldn't shouldn't he'd she'd they'd i've you've we've "
    + "people country going think know say said want need make made good bad thing things "
    + "back way well own see look come came around really actually something someone "
    + "everything nothing anything please thanks thank yeah okay gonna wanna every always "
    + "never ever mean means give gives took take time long lot bit sure today tonight "
    + "probably maybe quite pretty correct wrong agree agreed done says told tell").split(/\s+/),
);

export interface Trend {
  word: string;
  recent: number;
  prior: number;
  score: number;
  /** Set for two-word phrases; the component words. */
  parts?: string[];
}

/** The fields `computeTrends` needs from a comment. */
export interface TrendInput {
  body: string;
  /** ISO timestamp of when the comment was posted. */
  postedAt: string;
  /** Distinct authors give a term breadth; one person can't manufacture a trend. */
  author?: string;
  /** Engagement signals — a liked/replied-to comment lifts the words it uses. */
  likes?: number;
  replies?: number;
}

/** Whole-word, case-insensitive matcher for filtering the feed by a trend. */
export function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

const TOKEN = /[\p{L}][\p{L}\p{N}'']*/gu;
const isContentWord = (w: string) => w.length >= 3 && !STOPWORDS.has(w);
const bestForm = (forms: Map<string, number>) =>
  [...forms].sort((a, b) => b[1] - a[1])[0]?.[0];

interface Stat {
  /** Distinct authors who used the term in the recent window (breadth). */
  authors: Set<string>;
  /** Comments using it in the recent window. */
  recent: number;
  /** Comments using it in the prior window (for the surge factor). */
  prior: number;
  /** Extra weight from likes/replies on the comments using it. */
  engagement: number;
  /** Original spellings seen, for display casing. */
  forms: Map<string, number>;
}

function statFor(map: Map<string, Stat>, key: string): Stat {
  let s = map.get(key);
  if (!s) map.set(key, (s = { authors: new Set(), recent: 0, prior: 0, engagement: 0, forms: new Map() }));
  return s;
}

function record(map: Map<string, Stat>, key: string, display: string, ctx: {
  isRecent: boolean;
  author: string;
  weight: number;
}) {
  const s = statFor(map, key);
  if (ctx.isRecent) {
    s.recent += 1;
    s.engagement += ctx.weight;
    s.authors.add(ctx.author);
    s.forms.set(display, (s.forms.get(display) ?? 0) + 1);
  } else {
    s.prior += 1;
  }
}

export interface TrendOptions {
  /** Window treated as "now". Wider = steadier, less flicker. */
  recentMs?: number;
  priorMs?: number;
  limit?: number;
  /** Always return this many when the window has enough distinct terms. */
  minTrends?: number;
}

/**
 * Ranks words and two-word phrases by how much the chat is talking about them
 * *now*, blending three signals so the list stays populated and stable rather
 * than flickering on a hard threshold:
 *
 *   - breadth: how many distinct people mention it (one ranter can't trend)
 *   - engagement: likes and replies on the comments that use it
 *   - surge: a clamped recent-vs-prior ratio that lifts rising topics without
 *     dropping steady ones
 *
 * Phrases ("Paul Cox") beat their parts and suppress the bare words. The top
 * `limit` are returned, backfilled toward `minTrends` from weaker terms so the
 * bar rarely sits empty.
 */
export function computeTrends(comments: readonly TrendInput[], now: number, options: TrendOptions = {}): Trend[] {
  const recentMs = options.recentMs ?? 240_000; // 4 min — greedier than a single minute
  const priorMs = options.priorMs ?? recentMs * 2;
  const limit = options.limit ?? 4;
  const minTrends = options.minTrends ?? 3;

  const uni = new Map<string, Stat>();
  const bi = new Map<string, Stat>();

  for (const c of comments) {
    const age = now - new Date(c.postedAt).getTime();
    if (age < 0 || age > priorMs) continue;
    const isRecent = age <= recentMs;
    const author = c.author ?? "";
    // Diminishing engagement weight so a viral comment can't fully dominate.
    const weight = Math.min(6, (c.likes ?? 0) * 0.25 + (c.replies ?? 0) * 0.5);
    const ctx = { isRecent, author, weight };
    const matches = [...c.body.matchAll(TOKEN)];

    const seenUni = new Set<string>();
    for (const m of matches) {
      const lower = m[0].toLowerCase();
      if (!isContentWord(lower) || seenUni.has(lower)) continue;
      seenUni.add(lower);
      record(uni, lower, m[0], ctx);
    }

    // Adjacent content words separated by whitespace only, so "Yesss…. Paul"
    // never bridges punctuation into a phrase.
    const seenBi = new Set<string>();
    for (let i = 0; i + 1 < matches.length; i++) {
      const cur = matches[i]!;
      const next = matches[i + 1]!;
      const gap = c.body.slice(cur.index! + cur[0].length, next.index!);
      if (!/^\s+$/.test(gap)) continue;
      const a = cur[0].toLowerCase();
      const b = next[0].toLowerCase();
      if (!isContentWord(a) || !isContentWord(b)) continue;
      const key = `${a} ${b}`;
      if (seenBi.has(key)) continue;
      seenBi.add(key);
      record(bi, key, `${cur[0]} ${next[0]}`, ctx);
    }
  }

  const score = (s: Stat) => {
    const base = s.authors.size + s.engagement; // people + reactions
    const surge = Math.min(3, Math.max(0.6, (s.recent + 1) / (s.prior + 1)));
    return base * surge;
  };
  const toTrend = (key: string, s: Stat, boost: number, parts?: string[]): Trend => ({
    word: bestForm(s.forms) ?? key,
    recent: s.recent,
    prior: s.prior,
    score: score(s) * boost,
    parts,
  });

  const candidates: Trend[] = [];
  const consumed = new Set<string>();

  // Phrases first, boosted; suppress a bare word when the phrase covers most of it.
  for (const [key, s] of bi) {
    if (s.recent < 2) continue;
    const parts = key.split(" ");
    candidates.push(toTrend(key, s, 1.6, parts));
    for (const part of parts) {
      if (s.recent >= 0.6 * (uni.get(part)?.recent ?? 0)) consumed.add(part);
    }
  }

  const singles: Trend[] = [];
  for (const [key, s] of uni) {
    if (consumed.has(key)) continue;
    (s.recent >= 2 ? candidates : singles).push(toTrend(key, s, 1));
  }

  candidates.sort((a, b) => b.score - a.score);
  const result = candidates.slice(0, limit);

  // Backfill toward the minimum from single-mention terms so the bar rarely empties.
  if (result.length < minTrends) {
    singles.sort((a, b) => b.score - a.score);
    for (const s of singles) {
      if (result.length >= minTrends) break;
      result.push(s);
    }
  }
  return result;
}

export interface StickyEntry {
  /** Wall-clock time until which to keep showing this trend even if it fades. */
  until: number;
  trend: Trend;
}

/**
 * Keeps a topic on screen for a dwell time after it stops trending, so the row
 * doesn't churn — while letting fresh topics lead. Currently-trending topics
 * are ranked first (they can always take the top); faded-but-still-sticky ones
 * fill the remaining slots until their dwell expires. Mutates `sticky`.
 */
export function mergeStickyTrends(
  fresh: Trend[],
  sticky: Map<string, StickyEntry>,
  now: number,
  opts: { stickyMs?: number; display?: number } = {},
): Trend[] {
  const stickyMs = opts.stickyMs ?? 180_000; // 3 minutes
  const display = opts.display ?? 6;

  for (const t of fresh) sticky.set(t.word.toLowerCase(), { until: now + stickyMs, trend: t });
  for (const [key, entry] of sticky) if (entry.until <= now) sticky.delete(key);

  const freshKeys = new Set(fresh.map((t) => t.word.toLowerCase()));
  const faded = [...sticky.entries()]
    .filter(([key]) => !freshKeys.has(key))
    .map(([, entry]) => entry.trend)
    .sort((a, b) => b.score - a.score);
  const freshSorted = [...fresh].sort((a, b) => b.score - a.score);

  return [...freshSorted, ...faded].slice(0, display);
}
