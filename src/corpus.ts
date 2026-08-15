/**
 * A topical vocabulary sourced from the GB News RSS feed.
 *
 * Headlines tell us which names and subjects are in the live news cycle before
 * the chat has said them often enough to trend on its own. The corpus is used
 * ONLY to weight topic detection — nothing from the feed is ever rendered, so
 * a bad headline can at worst nudge a ranking, never put words on screen.
 *
 * Pure and framework-free: the server owns fetching/caching, the client only
 * receives the extracted term sets.
 */

import { normalize, STOPWORDS } from "./trending";

export interface Corpus {
  /** Single content-word stems seen in headlines. */
  stems: Set<string>;
  /** Multi-word proper-noun runs ("andy burnham"), stem-joined like trend keys. */
  phrases: Set<string>;
}

export interface CorpusJson {
  stems: string[];
  phrases: string[];
}

/** Bounds so a weird feed can't balloon the payload. */
const MAX_STEMS = 600;
const MAX_PHRASES = 200;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * Item titles from an RSS 2.0 document. The channel's own <title> (and the
 * image's) sit outside <item>, so only titles inside items are taken. Handles
 * both plain and CDATA-wrapped titles.
 */
export function parseRssTitles(xml: string): string[] {
  const titles: string[] = [];
  for (const item of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const m = /<title(?:\s[^>]*)?>(?:\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*|([\s\S]*?))<\/title>/.exec(item[1]!);
    if (!m) continue;
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (raw) titles.push(decodeEntities(raw));
  }
  return titles;
}

// Mirrors trending's TOKEN — standalone digit runs are words too, so a
// headline's "Saturday 5" yields the same stems the detector will look up.
const WORD = /[\p{L}][\p{L}\p{N}'']*|(?<![\p{L}\p{N}])\p{N}+(?![\p{L}\p{N}])/gu;
const PURE_DIGITS = /^\p{N}{1,4}$/u;

const isCap = (w: string) => {
  const c = w[0]!;
  return c === c.toUpperCase() && c !== c.toLowerCase();
};

// A digit can sit inside a proper-noun run ("Saturday 5") without breaking it,
// but a run made only of digits is a score, not a name — flush requires isCap.
const capOrDigit = (w: string) => isCap(w) || PURE_DIGITS.test(w);

/**
 * Distils headlines into the term sets the trend detector can weight by:
 * every significant stem, plus capitalised runs of two or more words as
 * phrases ("Andy Burnham", "Emmanuel Macron"). A title's first word is
 * capitalised by convention, so a run anchored at position zero only counts
 * when it is at least two words long — one word there proves nothing.
 */
export function buildCorpus(titles: readonly string[]): Corpus {
  const stems = new Set<string>();
  const phrases = new Set<string>();

  for (const title of titles) {
    const matches = [...title.matchAll(WORD)];

    for (const m of matches) {
      if (stems.size >= MAX_STEMS) break;
      const stem = normalize(m[0]);
      if ((stem.length >= 3 || PURE_DIGITS.test(stem)) && !STOPWORDS.has(stem)) stems.add(stem);
    }

    let run: string[] = [];
    const flush = () => {
      if (run.length >= 2 && run.some(isCap) && phrases.size < MAX_PHRASES) {
        const stemmed = run.map(normalize).filter((s) => (s.length >= 2 || PURE_DIGITS.test(s)) && !STOPWORDS.has(s));
        if (stemmed.length >= 2) phrases.add(stemmed.join(" "));
      }
      run = [];
    };
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      // Punctuation between words ends the run: "Keir Starmer & Rachel Reeves"
      // is two names, not one — the same whitespace-only rule the detector uses.
      if (i > 0) {
        const prev = matches[i - 1]!;
        const gap = title.slice(prev.index! + prev[0].length, m.index!);
        if (!/^\s+$/.test(gap)) flush();
      }
      if (capOrDigit(m[0])) run.push(m[0]);
      else flush();
    }
    flush();
  }

  return { stems, phrases };
}

export function corpusToJson(c: Corpus): CorpusJson {
  return { stems: [...c.stems], phrases: [...c.phrases] };
}

export function corpusFromJson(json: CorpusJson | null | undefined): Corpus {
  return {
    stems: new Set(Array.isArray(json?.stems) ? json.stems : []),
    phrases: new Set(Array.isArray(json?.phrases) ? json.phrases : []),
  };
}
