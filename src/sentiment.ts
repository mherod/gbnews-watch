/**
 * A tiny lexicon-based sentiment read of the room — enough to show whether the
 * chat is heated or upbeat, not a serious classifier. Scores are AFINN-style
 * (-3 … +3), weighted toward the vocabulary GB News commenters actually use.
 */

export const LEXICON: Record<string, number> = {
  // negative
  disgusting: -3, disgrace: -3, disgusted: -3, corrupt: -3, corruption: -3, traitor: -3,
  scumbag: -3, evil: -3, hate: -3, hateful: -3, stupid: -3, idiot: -3, idiots: -2, moron: -3,
  pathetic: -2, useless: -2, rubbish: -2, nonsense: -2, joke: -2, clown: -2, liar: -2, lies: -2,
  lying: -2, shame: -2, shameful: -2, scandal: -2, disaster: -2, disgraceful: -3, appalling: -3,
  ridiculous: -2, terrible: -3, awful: -3, horrible: -3, nasty: -2, angry: -2, furious: -3,
  fuming: -2, sick: -2, sickening: -3, fed: -1, wrong: -2, fail: -2, failed: -2, failure: -2,
  crisis: -2, chaos: -2, broken: -2, waste: -2, wasted: -2, dangerous: -2, threat: -2, fear: -2,
  scared: -2, worried: -2, worry: -1, sad: -2, tragic: -3, tragedy: -3, mad: -2, betrayed: -3,
  betrayal: -3, coward: -2, weak: -2, incompetent: -3, unbelievable: -1, outrageous: -3, robbed: -2,
  criminal: -2, illegal: -1, invasion: -2, disgust: -3, contempt: -2, vile: -3, filth: -3, filthy: -3,
  barmy: -2, bonkers: -2, bollocks: -3, shambles: -3, shambolic: -3, daft: -2, prat: -2, tosh: -2,
  drivel: -2, codswallop: -2, muppet: -2, gutted: -2, miffed: -1, dodgy: -2, con: -2, swindle: -2,
  twit: -2, bodge: -2, bodged: -2,
  // positive
  great: 2, love: 3, loved: 3, lovely: 2, brilliant: 3, excellent: 3, superb: 3, fantastic: 3,
  wonderful: 3, amazing: 3, awesome: 3, good: 1, agree: 2, agreed: 2, spot: 1, correct: 1,
  right: 1, best: 2, hope: 1, hopeful: 1, proud: 2, support: 1, supported: 1, thanks: 1, thank: 1,
  cheers: 1, well: 1, nice: 2, happy: 2, glad: 2, brave: 2, hero: 3, legend: 2, respect: 2,
  sensible: 2, fair: 1, honest: 2, truth: 1, wise: 2, funny: 2, congratulations: 3, welcome: 1,
  bravo: 3, genius: 3, perfect: 3, yes: 1, champion: 2, deserve: 1, deserved: 1, grateful: 2,
  blessed: 2, smashing: 2, marvellous: 3, chuffed: 2, cracking: 2, solid: 1, proper: 1,
  belter: 2, banger: 2, sound: 1, tidy: 1, ace: 2, splendid: 3, corker: 2,
  // more negative (common in these comments)
  outrage: -2, outraged: -2, shameless: -2, spineless: -2, clueless: -2, hopeless: -2, mess: -2,
  dreadful: -3, grim: -2, cruel: -2, brutal: -2, greedy: -2, liars: -2, cheat: -2, cheats: -2,
  cheating: -2, fraud: -2, scam: -2, fake: -2, biased: -2, traitors: -3, invaders: -2, invader: -2,
  rot: -2, rotten: -2, enough: -1, damning: -2, insane: -2,
  // harvested from the live feed (scripts/debug-sentiment-gaps.ts) and the
  // room's running register
  obnoxious: -3, fool: -2, stooge: -2, fibber: -2, wreck: -2, wrecked: -2, mouthpiece: -2,
  attack: -1, tosser: -3, gaslight: -2, gaslighting: -2, nutter: -2, eejit: -2, twaddle: -2,
  shite: -3, garbage: -2,
};

/**
 * Emoji are tidy sentiment signals — often clearer than the words around them.
 * Keyed by the bare glyph (variation selectors and skin tones are stripped
 * before lookup).
 */
export const EMOJI_LEXICON: Record<string, number> = {
  "😂": 2, "🤣": 2, "😁": 2, "😄": 2, "😆": 2, "😅": 1, "😊": 2, "🙂": 1, "😉": 1, "😍": 3,
  "🥰": 3, "😘": 2, "😎": 2, "🤩": 3, "🥳": 3, "👏": 2, "👍": 2, "🙌": 2, "💪": 2, "👌": 2,
  "❤": 3, "❤️": 3, "💙": 2, "💚": 2, "🧡": 2, "🙏": 1, "✌": 1, "🎉": 2, "😇": 2, "🤗": 2,
  "😠": -2, "😡": -3, "🤬": -3, "😤": -2, "👎": -2, "😢": -2, "😭": -2, "😞": -2, "😔": -2,
  "😟": -1, "😕": -1, "🙄": -2, "😒": -2, "🤮": -3, "🤢": -2, "💩": -3, "🤡": -2, "😱": -2,
  "😨": -2, "😰": -1, "🤦": -2, "🤷": -1, "😐": -1, "😑": -1, "🖕": -3, "😬": -1, "🥴": -1,
  // harvested from the live feed
  "🤞": 1, "🥂": 2, "🩵": 2, "🤭": 1,
};

const EMOJI_GRAPHEME = /\p{Extended_Pictographic}/u;
const moodSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Strip variation selectors and skin-tone modifiers so a glyph matches the lexicon. */
function bareEmoji(grapheme: string): string {
  return grapheme.replace(/[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, "");
}

export interface Mood {
  /** Mean sentiment across scored comments, roughly -3 … +3. */
  score: number;
  /** How many recent comments carried any sentiment. */
  count: number;
  label: string;
  emoji: string;
  /** When the room is genuinely split, what's in the mix (e.g. "60% 🔥 · 40% 🙂"). */
  detail?: string;
  /** Share of scored comments leaning negative / positive. */
  negFrac: number;
  posFrac: number;
  /** For styling: a hue bucket. */
  tone: "heated" | "grumbly" | "mixed" | "warm" | "buzzing";
}

const WORD = /[\p{L}][\p{L}']*/gu;

/**
 * Light plural fold so "clowns"/"hopes"/"illegals" score via their singular
 * entries (both were live in the feed unscored). Exact lookup wins first, so
 * explicitly scored plurals like "idiots" keep their own weight.
 */
function sentimentStem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Sentiment value of a single emoji glyph, if known. */
export function emojiSentiment(grapheme: string): number | undefined {
  return EMOJI_LEXICON[grapheme] ?? EMOJI_LEXICON[bareEmoji(grapheme)];
}

/** Net sentiment of one comment (words + emoji), or null if it carries none. */
export function scoreText(text: string): number | null {
  let sum = 0;
  let hits = 0;
  let negate = false;
  for (const m of text.toLowerCase().matchAll(WORD)) {
    const word = m[0];
    if (word === "not" || word === "no" || word === "never" || word.endsWith("n't")) {
      negate = true;
      continue;
    }
    const value = LEXICON[word] ?? LEXICON[sentimentStem(word)];
    if (value !== undefined) {
      sum += negate ? -value : value;
      hits += 1;
    }
    negate = false;
  }
  // Emoji are strong, unambiguous signals — count each occurrence.
  for (const { segment } of moodSegmenter.segment(text)) {
    if (!EMOJI_GRAPHEME.test(segment)) continue;
    const value = emojiSentiment(segment);
    if (value !== undefined) {
      sum += value;
      hits += 1;
    }
  }
  return hits === 0 ? null : sum / hits;
}

/**
 * Classifies by the *balance* of angry vs happy comments, not the mean — a mean
 * collapses a heated-but-mixed room to "neutral". Leans to a side readily, and
 * only calls it "Divided" when the split is genuinely close, spelling out the mix.
 */
function classify(neg: number, pos: number): Pick<Mood, "label" | "emoji" | "tone" | "detail"> {
  const total = neg + pos;
  if (total === 0) return { label: "Fair Enough", emoji: "☕", tone: "mixed" };
  const nf = neg / total;
  if (nf >= 0.72) return { label: "Proper Fuming", emoji: "😡", tone: "heated" };
  if (nf >= 0.56) return { label: "A Bit Miffed", emoji: "😤", tone: "grumbly" };
  if (nf <= 0.28) return { label: "Proper Chuffed", emoji: "🎉", tone: "buzzing" };
  if (nf <= 0.44) return { label: "Not Bad, Actually", emoji: "☕", tone: "warm" };
  const negPct = Math.round(nf * 100);
  return { label: "Divided", emoji: "⚖️", tone: "mixed", detail: `${negPct}% 😤 · ${100 - negPct}% ☕` };
}

/** Reads the room by the balance of positive vs negative comments. */
export function roomMood(
  comments: readonly { body: string; postedAt: string }[],
  now: number,
  opts: { windowMs?: number; minScored?: number } = {},
): Mood | null {
  const windowMs = opts.windowMs ?? 300_000;
  const minScored = opts.minScored ?? 4;

  let sum = 0;
  let count = 0;
  let neg = 0;
  let pos = 0;
  for (const c of comments) {
    if (now - new Date(c.postedAt).getTime() > windowMs) continue;
    const s = scoreText(c.body);
    if (s === null) continue;
    sum += s;
    count += 1;
    if (s < 0) neg += 1;
    else if (s > 0) pos += 1;
  }
  if (count < minScored) return null;
  const denom = neg + pos || 1;
  return {
    score: sum / count,
    count,
    negFrac: neg / denom,
    posFrac: pos / denom,
    ...classify(neg, pos),
  };
}
