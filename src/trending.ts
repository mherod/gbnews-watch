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
    + "never ever mean means give gives took take").split(/\s+/),
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
}

/** Whole-word, case-insensitive matcher for filtering the feed by a trend. */
export function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

const TOKEN = /[\p{L}][\p{L}\p{N}'']*/gu;
const isContentWord = (w: string) => w.length >= 3 && !STOPWORDS.has(w);
const bestForm = (forms?: Map<string, number>) =>
  forms ? [...forms].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;

interface Counter {
  recent: Map<string, number>;
  prior: Map<string, number>;
  forms: Map<string, Map<string, number>>;
}

const newCounter = (): Counter => ({ recent: new Map(), prior: new Map(), forms: new Map() });

function bump(counter: Counter, key: string, display: string, isRecent: boolean) {
  const bucket = isRecent ? counter.recent : counter.prior;
  bucket.set(key, (bucket.get(key) ?? 0) + 1);
  if (isRecent) {
    let m = counter.forms.get(key);
    if (!m) counter.forms.set(key, (m = new Map()));
    m.set(display, (m.get(display) ?? 0) + 1);
  }
}

export interface TrendOptions {
  recentMs?: number;
  priorMs?: number;
  /** Minimum comments in the recent window that must mention a term. */
  minRecent?: number;
  limit?: number;
}

/**
 * Compares the last `recentMs` against the `recentMs` before it, so a term that
 * suddenly floods the chat rises while always-common words stay flat. A phrase
 * like "Paul Cox" is boosted above its parts, and once shown the bare "Paul"
 * and "Cox" are suppressed.
 */
export function computeTrends(comments: readonly TrendInput[], now: number, options: TrendOptions = {}): Trend[] {
  const recentMs = options.recentMs ?? 60_000;
  const priorMs = options.priorMs ?? recentMs * 2;
  const minRecent = options.minRecent ?? 3;
  const limit = options.limit ?? 4;

  const uni = newCounter();
  const bi = newCounter();

  for (const c of comments) {
    const age = now - new Date(c.postedAt).getTime();
    if (age < 0 || age > priorMs) continue;
    const isRecent = age <= recentMs;
    const matches = [...c.body.matchAll(TOKEN)];

    const seenUni = new Set<string>();
    for (const m of matches) {
      const lower = m[0].toLowerCase();
      if (!isContentWord(lower) || seenUni.has(lower)) continue;
      seenUni.add(lower);
      bump(uni, lower, m[0], isRecent);
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
      bump(bi, key, `${cur[0]} ${next[0]}`, isRecent);
    }
  }

  const surge = (r: number, p: number) => r * (r / (p + 1));
  const candidates: Trend[] = [];
  const consumed = new Set<string>();

  for (const [key, r] of bi.recent) {
    if (r < minRecent) continue;
    const p = bi.prior.get(key) ?? 0;
    if (r <= p) continue;
    const parts = key.split(" ");
    candidates.push({ word: bestForm(bi.forms.get(key)) ?? key, recent: r, prior: p, score: surge(r, p) * 1.6, parts });
    for (const part of parts) {
      if (r >= 0.6 * (uni.recent.get(part) ?? 0)) consumed.add(part);
    }
  }

  for (const [key, r] of uni.recent) {
    if (consumed.has(key) || r < minRecent) continue;
    const p = uni.prior.get(key) ?? 0;
    if (r <= p) continue;
    candidates.push({ word: bestForm(uni.forms.get(key)) ?? key, recent: r, prior: p, score: surge(r, p) });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}
