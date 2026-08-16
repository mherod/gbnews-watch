/**
 * Surfacing words and two-word phrases that are surging in the live comment
 * stream. Pure and framework-free so it can be unit-tested; the UI calls
 * `computeTrends` on a short interval.
 */

import { BOILERPLATE_STEMS, entityPattern, matchEntityAt } from "./entities";

export const STOPWORDS = new Set(
  ("the a an and or but if then than that this these those they them their there here "
    + "you your yours we our ours us he she him her his it its i me my mine "
    + "is are was were be been being am do does did doing have has had having "
    + "will would can could should shall may might must of to in on at by for with "
    + "from into over under out up down off about as so not no yes just like get got "
    + "one two all any some more most much many very too also even still now then when only "
    // Quantifiers, determiners and indefinite pronouns: breadth without a topic.
    // Stems only ("others" normalizes to "other"), since isContentWord tests the
    // stem — the hole "sometimes" slipped through.
    + "another other several few certain none both each either neither plenty "
    + "anyone everyone nobody somebody everybody anybody "
    // Prepositional/connective glue and a stock typo, all seen minting phrase
    // chips on the live board: "via Left", "motors etc", "teh price". "cent"
    // rides along with "per" — without its glue word it is a bare fragment.
    + "via per cent vs versus amid etc teh "
    + "what who whom which why how where whose because while after before again once "
    + "he's she's it's i'm you're they're we're don't didn't doesn't isn't aren't wasn't "
    + "can't won't wouldn't couldn't shouldn't he'd she'd they'd i've you've we've "
    + "people country going think know say said want need make made good bad thing things "
    + "back way well own see look come came around really actually something someone "
    + "everything nothing anything please thanks thank yeah okay gonna wanna every always "
    + "never ever mean means give gives took take time long lot bit sure today tonight "
    + "probably maybe sometimes sometime quite pretty correct wrong agree agreed done says told tell let lets "
    + "stand put keep keeps got getting "
    // contraction stems left behind when a non-standard apostrophe splits the word
    + "doesn don didn isn aren wasn weren won wouldn couldn shouldn haven hasn hadn ain mustn "
    + "wont cant dont didnt doesnt isnt arent wasnt werent wouldnt couldnt shouldnt havent").split(/\s+/),
);

export interface Trend {
  word: string;
  recent: number;
  prior: number;
  score: number;
  /** Set for two-word phrases; the component words. */
  parts?: string[];
  /**
   * Regex-source alternation of every form this trend should highlight/filter
   * on — set for known entities so the "Conservative" chip still lights up
   * "Tory". Undefined for ordinary trends (they match their own word).
   */
  pattern?: string;
  /** Distinct voices (authors) behind this trend; <2 means single-voice filler. */
  authors?: number;
  /** Filler shown only to keep the row populated when little is trending; the UI mutes it. */
  weak?: boolean;
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

/**
 * Whole-word, case-insensitive matcher for filtering the feed by a trend. Pass
 * a trend's `pattern` (an alias alternation) to match every form of an entity —
 * so filtering by "Conservative" also catches "Tory".
 */
export function termRegex(term: string, pattern?: string): RegExp {
  const source = pattern ?? term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:${source})\\b`, "i");
}

// Digit runs are tokens too: without them "Saturday 5" tokenises as just
// ["Saturday"], so it could never match "Saturday Five" — and the corpus's
// "channel 4" alias could never fire at all. Only *standalone* runs, though:
// "5th"/"5pm"/"70s" must not shed a bare "5" that mints a phantom "Saturday 5"
// trend whose own matcher can't find it in the source text.
const TOKEN = /[\p{L}][\p{L}\p{N}'']*|(?<![\p{L}\p{N}])\p{N}+(?![\p{L}\p{N}])/gu;

/**
 * Written numbers folded to digits for *comparison* — "Saturday Five" and
 * "SATURDAY 5" are one topic. Deliberately three–twenty only: "one"/"two" are
 * stopwords (and would stop being if their stems became digits), and "zero"
 * belongs to Net Zero.
 */
const NUMBER_WORDS: Record<string, string> = {
  three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14",
  fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  twenty: "20",
};

const DIGIT_WORDS: Record<string, string> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([w, d]) => [d, w]),
);

/** Matches the digit runs `normalize` can produce from phrase stems. */
const PURE_DIGITS = /^\p{N}{1,4}$/u;

/**
 * Highlight/filter pattern for a phrase whose key contains a folded number, so
 * the "Saturday 5" chip lights up "Saturday Five" and "SATURDAY 5" alike.
 * Undefined when no number is involved — ordinary trends keep the cheap
 * match-own-word path.
 */
export function numberAwarePattern(key: string, display?: string): string | undefined {
  const words = key.split(" ");
  if (!words.some((w) => DIGIT_WORDS[w] !== undefined)) return undefined;
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fromStems = words
    .map((w) => (DIGIT_WORDS[w] !== undefined ? `(?:${w}|${DIGIT_WORDS[w]}s?)` : esc(w)))
    .join("\\s+");
  // The chip must always match its own display spelling — the key holds stems,
  // and "Rugby Sevens" would otherwise show a count its filter can't reproduce.
  if (display && display.toLowerCase() !== key) return `${fromStems}|${esc(display)}`;
  return fromStems;
}

const URL_OR_NON_PROSE: RegExp[] = [
  // Full http/https URLs with query params/fragments
  /https?:\/\/\S+/gi,
  // www. links
  /\bwww\.\S+/gi,
  // Common bare domain links (e.g. youtube.com/watch?v=..., youtu.be/...)
  /\b[a-zA-Z0-9-]+\.(?:com|org|net|co\.uk|gov\.uk|io|tv|me|be|app|info|news|edu|co)(?:\/\S*)?\b/gi,
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
  // User mentions (@handle)
  /@[\w-]+/g,
  // HTML tags
  /<[^>]+>/g,
];

/**
 * Strips URLs, domain links, email addresses, and @handles from comment text,
 * replacing each with a punctuation break (" . "). This prevents URL fragments
 * (e.g. youtube, com, watch, opaque video IDs) from decomposing into tokens and
 * dominating the topic map, while also breaking any accidental bigram/phrase bridging.
 */
export function stripNonProse(body: string): string {
  let text = body;
  for (const re of URL_OR_NON_PROSE) {
    text = text.replace(re, " . ");
  }
  return text;
}

/**
 * Light stemmer: lowercases, drops a possessive/contraction "'s", and folds
 * common plurals so "toilet"/"toilets" and "party"/"parties" count as one. Not
 * a full Porter stemmer — just enough to stop obvious duplicates splitting a
 * trend, and it turns "there's" into the stopword "there".
 */
export function normalize(word: string): string {
  const s = word.toLowerCase().replace(/['']s$/, "");
  let stem = s;
  if (s.length > 4 && s.endsWith("ies")) stem = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(?:s|x|z|ch|sh)es$/.test(s)) stem = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !/(?:ss|us|is)$/.test(s)) stem = s.slice(0, -1);
  // Number fold last, so "fives" stems to "five" and lands on "5".
  return NUMBER_WORDS[stem] ?? stem;
}

/** Capitalised but not SHOUTING — a rough proper-noun signal (names, places). */
export function isCapitalized(word: string): boolean {
  const first = word[0];
  return first !== undefined && first !== first.toLowerCase() && word !== word.toUpperCase();
}

/**
 * True when the match at `index` opens the comment or follows end-of-sentence
 * punctuation (closing quotes/brackets skipped). English capitalises there
 * regardless of noun-ness, so the position carries no proper-noun signal —
 * "Sometimes I wonder…" must not read as a name the way "blame Pinfold" does.
 */
export function isSentenceInitial(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /[\s"'""''()\[\]]/.test(text[i]!)) i--;
  if (i < 0) return true;
  return /[.!?…\n]/.test(text[i]!);
}

export const isContentWord = (stem: string) =>
  stem.length >= 3 && !STOPWORDS.has(stem) && !BOILERPLATE_STEMS.has(stem) && !/\d/.test(stem);

/**
 * A word allowed *inside* a phrase: a content word, or a short digit run so
 * "Saturday 5" can form. Digits still can't trend alone (isContentWord rejects
 * them, so years and counts stay out), and every phrase must contain at least
 * one true content word — checked at the call sites.
 */
export const isPhrasePart = (stem: string) => isContentWord(stem) || PURE_DIGITS.test(stem);
const bestForm = (forms: Map<string, number>) =>
  [...forms].sort((a, b) => b[1] - a[1])[0]?.[0];

interface Stat {
  /** Distinct authors who used the term in the recent window (breadth). */
  authors: Set<string>;
  /** Comments using it in the recent window. */
  recent: number;
  /** Comments using it in the prior window (for the surge factor). */
  prior: number;
  /** Recent comments where it appeared capitalised (proper-noun signal). */
  caps: number;
  /** Extra weight from likes/replies on the comments using it. */
  engagement: number;
  /** Original spellings seen, for display casing. */
  forms: Map<string, number>;
}

function statFor(map: Map<string, Stat>, key: string): Stat {
  let s = map.get(key);
  if (!s) map.set(key, (s = { authors: new Set(), recent: 0, prior: 0, caps: 0, engagement: 0, forms: new Map() }));
  return s;
}

function record(map: Map<string, Stat>, key: string, display: string, ctx: {
  isRecent: boolean;
  author: string;
  weight: number;
  cap: boolean;
}) {
  const s = statFor(map, key);
  if (ctx.isRecent) {
    s.recent += 1;
    s.engagement += ctx.weight;
    s.authors.add(ctx.author);
    if (ctx.cap) s.caps += 1;
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
  /**
   * Vocabulary from the current news cycle (RSS headlines). Terms found here
   * rank higher — the chat reacting to a story the channel is running is very
   * likely the real topic. Detection weight only; never rendered.
   */
  corpus?: { stems: ReadonlySet<string>; phrases: ReadonlySet<string> };
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
  const corpus = options.corpus;

  /**
   * News-cycle boost for a stem key ("bbq", "andy burnham"). A full phrase
   * match is the strongest signal; all-words-known is a softer one. Kept
   * modest so the corpus steers ties rather than overruling the room.
   */
  const corpusBoost = (stemKey: string): number => {
    if (!corpus) return 1;
    if (corpus.phrases.has(stemKey)) return 1.5;
    const parts = stemKey.split(" ");
    return parts.every((p) => corpus.stems.has(p)) ? 1.25 : 1;
  };

  const uni = new Map<string, Stat>();
  const bi = new Map<string, Stat>();
  const tri = new Map<string, Stat>(); // three-word proper-noun names (Muhammad Ziauddin Yusuf)
  const conn = new Map<string, Stat>(); // two topics bridged by short stopword glue
  const ent = new Map<string, Stat>(); // curated known entities (NHS, Tory→Conservative)

  interface ParsedComment {
    isRecent: boolean;
    author: string;
    weight: number;
    cleanBody: string;
    matches: RegExpExecArray[];
    tokens: string[];
  }

  const parsed: ParsedComment[] = [];
  let recentCommentCount = 0;
  const docCounts = new Map<string, number>();

  for (const c of comments) {
    const age = now - new Date(c.postedAt).getTime();
    if (age < 0 || age > priorMs) continue;
    const isRecent = age <= recentMs;
    const author = c.author ?? "";
    // Diminishing engagement weight so a viral comment can't fully dominate.
    const weight = Math.min(6, (c.likes ?? 0) * 0.25 + (c.replies ?? 0) * 0.5);
    const cleanBody = stripNonProse(c.body);
    const matches = [...cleanBody.matchAll(TOKEN)];
    const tokens = matches.map((m) => m[0]);
    if (isRecent) {
      recentCommentCount += 1;
      const seen = new Set(tokens.map(normalize).filter(isContentWord));
      for (const stem of seen) {
        docCounts.set(stem, (docCounts.get(stem) ?? 0) + 1);
      }
    }
    parsed.push({ isRecent, author, weight, cleanBody, matches, tokens });
  }

  const isBoilerplate = (stem: string): boolean => {
    if (BOILERPLATE_STEMS.has(stem)) return true;
    if (corpus?.stems.has(stem)) return false;
    if (recentCommentCount >= 15 && (docCounts.get(stem) ?? 0) / recentCommentCount > 0.35) {
      return true;
    }
    return false;
  };

  for (const { isRecent, author, weight, cleanBody, matches, tokens } of parsed) {
    // Known-entity pass first: greedily match curated aliases (longest wins),
    // canonicalise ("Tory" → "Conservative"), and mark the consumed token spans
    // so the generic passes below skip them. Entities count as strong topics
    // (cap: true) and reach the candidate list even when 2 letters long (EU).
    const entIdx = new Set<number>();
    const seenEnt = new Set<string>();
    for (let i = 0; i < tokens.length; ) {
      const hit = matchEntityAt(tokens, i);
      if (hit) {
        for (let k = i; k < i + hit.length; k++) entIdx.add(k);
        seenEnt.add(hit.canonical);
        i += hit.length;
      } else {
        i += 1;
      }
    }
    for (const canonical of seenEnt) record(ent, canonical, canonical, { isRecent, author, weight, cap: true });

    // Collect each unique stem once per comment, remembering a display spelling
    // and whether it showed up capitalised in an *informative* position — a
    // sentence-initial capital is obligatory English, not a proper-noun hint,
    // so "Apparently"/"Sometimes" openers earn nothing here.
    const seenUni = new Map<string, { display: string; cap: boolean }>();
    for (let mi = 0; mi < matches.length; mi++) {
      if (entIdx.has(mi)) continue; // already claimed by an entity
      const stem = normalize(tokens[mi]!);
      if (!isContentWord(stem) || isBoilerplate(stem)) continue;
      const cap = isCapitalized(tokens[mi]!) && !isSentenceInitial(cleanBody, matches[mi]!.index!);
      const prev = seenUni.get(stem);
      if (!prev) seenUni.set(stem, { display: tokens[mi]!, cap });
      else if (cap) prev.cap = true;
    }
    for (const [stem, info] of seenUni) record(uni, stem, info.display, { isRecent, author, weight, cap: info.cap });

    // Adjacent content words separated by whitespace only, so "Yesss…. Paul"
    // never bridges punctuation into a phrase.
    const seenBi = new Set<string>();
    for (let i = 0; i + 1 < matches.length; i++) {
      if (entIdx.has(i) || entIdx.has(i + 1)) continue; // don't bridge into an entity
      const cur = matches[i]!;
      const next = matches[i + 1]!;
      const gap = cleanBody.slice(cur.index! + cur[0].length, next.index!);
      if (!/^\s+$/.test(gap)) continue;
      const a = normalize(cur[0]);
      const b = normalize(next[0]);
      if (!isPhrasePart(a) || !isPhrasePart(b) || isBoilerplate(a) || isBoilerplate(b)) continue;
      if (!isContentWord(a) && !isContentWord(b)) continue; // "5 6" is not a topic
      const key = `${a} ${b}`;
      if (seenBi.has(key)) continue;
      seenBi.add(key);
      // Digits are neutral in a name pair, matching the trigram rule — but a
      // pair still needs at least one genuinely capitalised word to read as a
      // name, or "5 6" chatter would earn the proper-noun boost.
      const capNeutral = (w: string) => isCapitalized(w) || PURE_DIGITS.test(w);
      record(bi, key, `${cur[0]} ${next[0]}`, {
        isRecent,
        author,
        weight,
        cap:
          capNeutral(cur[0]) && capNeutral(next[0]) &&
          (isCapitalized(cur[0]) || isCapitalized(next[0])),
      });
    }

    // Proper-noun trigrams: three consecutive Capitalised content words with
    // whitespace-only gaps — a full name like "Muhammad Ziauddin Yusuf". These
    // fold the overlapping name-bigrams ("Muhammad Ziauddin" + "Ziauddin Yusuf")
    // into a single topic below. Restricted to capitalised runs so generic
    // three-word phrases don't flood in.
    const seenTri = new Set<string>();
    for (let i = 0; i + 2 < matches.length; i++) {
      if (entIdx.has(i) || entIdx.has(i + 1) || entIdx.has(i + 2)) continue;
      const t0 = matches[i]!;
      const t1 = matches[i + 1]!;
      const t2 = matches[i + 2]!;
      const g1 = cleanBody.slice(t0.index! + t0[0].length, t1.index!);
      const g2 = cleanBody.slice(t1.index! + t1[0].length, t2.index!);
      if (!/^\s+$/.test(g1) || !/^\s+$/.test(g2)) continue;
      // A digit token is neutral in a name run — "Radio 5 Live" is one name.
      const capOrDigit = (w: string) => isCapitalized(w) || PURE_DIGITS.test(w);
      if (!capOrDigit(t0[0]) || !capOrDigit(t1[0]) || !capOrDigit(t2[0])) continue;
      const a = normalize(t0[0]);
      const b = normalize(t1[0]);
      const d = normalize(t2[0]);
      if (!isPhrasePart(a) || !isPhrasePart(b) || !isPhrasePart(d) || isBoilerplate(a) || isBoilerplate(b) || isBoilerplate(d)) continue;
      if ([a, b, d].filter(isContentWord).length < 2) continue; // names need words
      const key = `${a} ${b} ${d}`;
      if (seenTri.has(key)) continue;
      seenTri.add(key);
      record(tri, key, `${t0[0]} ${t1[0]} ${t2[0]}`, { isRecent, author, weight, cap: true });
    }

    // Connective phrases: two content words bridged by 1–2 stopwords joined only
    // by whitespace — "stop the boats", "power to the people". They slip past the
    // adjacent-bigram net because a stopword sits between the two topics, yet the
    // bridged substring is often the real headline. We only record the phrase
    // formed with the *nearest* following content word so longer, noisier spans
    // don't accumulate.
    const seenConn = new Set<string>();
    for (let i = 0; i + 2 < matches.length; i++) {
      if (entIdx.has(i)) continue; // an entity isn't a bare connective endpoint
      const first = matches[i]!;
      const head = normalize(first[0]);
      if (!isContentWord(head) || isBoilerplate(head)) continue;
      let bridges = 0;
      for (let j = i + 1; j < matches.length && bridges <= 2; j++) {
        if (entIdx.has(j)) break; // stop at an entity token
        const prev = matches[j - 1]!;
        const cur = matches[j]!;
        const gap = cleanBody.slice(prev.index! + prev[0].length, cur.index!);
        if (!/^\s+$/.test(gap)) break; // punctuation ends the run — no phrase across it
        const stem = normalize(cur[0]);
        if (STOPWORDS.has(stem)) {
          bridges += 1; // a bit of glue ("the", "our", "all")
          continue;
        }
        if (!isContentWord(stem) || isBoilerplate(stem)) break;
        if (bridges >= 1) {
          const stems: string[] = [];
          const forms: string[] = [];
          for (let k = i; k <= j; k++) {
            stems.push(normalize(matches[k]![0]));
            forms.push(matches[k]![0]);
          }
          const key = stems.join(" ");
          if (!seenConn.has(key)) {
            seenConn.add(key);
            record(conn, key, forms.join(" "), {
              isRecent,
              author,
              weight,
              cap: isCapitalized(first[0]) && isCapitalized(cur[0]),
            });
          }
        }
        break; // pair only with the nearest content word (bridges === 0 → bigram loop)
      }
    }
  }

  const score = (s: Stat) => {
    const base = s.authors.size + s.engagement; // people + reactions
    const surge = Math.min(3, Math.max(0.6, (s.recent + 1) / (s.prior + 1)));
    // Capitalisation is a cheap hint toward proper nouns (names/places), which
    // are usually the real topics. Graduated by how consistently the word is
    // capitalised, so an always-capitalised "Burnham" (×1.8) beats a
    // sometimes-capitalised word (×1.3 at the 0.6 threshold) beats a generic one.
    const capRatio = s.recent > 0 ? s.caps / s.recent : 0;
    const properNoun = s.recent >= 2 && capRatio >= 0.6 ? 1 + 0.8 * capRatio : 1;
    return base * surge * properNoun;
  };
  const toTrend = (key: string, s: Stat, boost: number, parts?: string[]): Trend => ({
    word: bestForm(s.forms) ?? key,
    recent: s.recent,
    prior: s.prior,
    score: score(s) * boost * corpusBoost(key),
    authors: s.authors.size,
    parts,
  });

  const candidates: Trend[] = [];
  const consumed = new Set<string>();
  const claimed = new Set<string>(); // phrase endpoints already spoken for

  // Phrases already spoken for — kept or folded — with their raw stats, so a
  // later window of the same repeated sentence can be recognised by chaining
  // off one of these with lockstep support (same count, same voices).
  const spanAnchors: Array<{ parts: string[]; s: Stat }> = [];
  const sameVoices = (x: ReadonlySet<string>, y: ReadonlySet<string>) =>
    x.size === y.size && [...x].every((v) => y.has(v));
  // Drop a window but suppress the words that live only inside it, exactly as
  // the connective pass does — "comunisim" must not resurface as a bare chip.
  const foldWindow = (parts: string[], s: Stat) => {
    spanAnchors.push({ parts, s });
    for (const w of parts) {
      claimed.add(w);
      const u = uni.get(w);
      if (u && s.recent >= 0.6 * u.recent) consumed.add(w);
    }
  };

  // Proper-noun trigrams (full names) first, strongest first: they claim all
  // three words so the overlapping name-bigrams below fold into the single
  // full name — "Muhammad Ziauddin Yusuf", not "Muhammad Ziauddin" +
  // "Ziauddin Yusuf". Two trigrams sharing a whole bigram are re-windowings of
  // one longer span — "Fabian Society Invent" beside "Society Invent
  // Comunisim" — so the stronger speaks and the weaker folds into it.
  for (const [key, s] of [...tri.entries()].sort((a, b) => score(b[1]) - score(a[1]))) {
    if (s.recent < 2) continue;
    const parts = key.split(" ");
    // A re-windowing of one longer span: a single stronger anchor's two-word
    // tail is this trigram's head (or vice versa), with the very same support
    // — same count, same voices. Sharing one word with each of two different
    // names is NOT that, and a genuine third topic keeps its chip.
    const rewindowed = spanAnchors.some((k) => {
      if (k.s.recent !== s.recent || !sameVoices(k.s.authors, s.authors)) return false;
      const kp = k.parts;
      return (
        (kp[kp.length - 2] === parts[0] && kp[kp.length - 1] === parts[1]) ||
        (kp[0] === parts[1] && kp[1] === parts[2])
      );
    });
    if (rewindowed) {
      foldWindow(parts, s);
      continue;
    }
    const triWord = bestForm(s.forms) ?? key;
    candidates.push({
      word: triWord,
      recent: s.recent,
      prior: s.prior,
      score: score(s) * 1.6 * corpusBoost(key),
      authors: s.authors.size,
      parts,
      pattern: numberAwarePattern(key, triWord),
    });
    spanAnchors.push({ parts, s });
    for (const w of parts) {
      claimed.add(w);
      consumed.add(w);
    }
  }

  // Bigram phrases, boosted. A bare word is dropped when the phrase covers most
  // of it; and a proper-noun phrase *absorbs and upgrades* a more-popular bare
  // part — so "Stadlen" (20) and "Matthew Stadlen" (4) become one "Matthew
  // Stadlen" topic carrying the bigger count, not two chips for the same person.
  // Each bigram is a distinct phrase (kept), and claims its endpoints so the
  // connective pass below can't re-fragment the same topic.
  for (const [key, s] of [...bi.entries()].sort((a, b) => score(b[1]) - score(a[1]))) {
    if (s.recent < 2) continue;
    const parts = key.split(" ");
    if (parts.every((p) => claimed.has(p))) continue; // both words already in a full-name trigram
    // Consecutive windows of one repeated sentence chain off a spoken-for
    // phrase's edge with the very same support — "open mic" → "mic last" →
    // "last night", each sharing its junction word, count and voices. A
    // genuine sibling topic sharing a word ("stop boats" / "small boats")
    // brings its own commenters, breaks the lockstep, and survives.
    const chained = spanAnchors.some(
      (k) =>
        (k.parts[k.parts.length - 1] === parts[0] || k.parts[0] === parts[parts.length - 1]) &&
        k.s.recent === s.recent &&
        sameVoices(k.s.authors, s.authors),
    );
    if (chained) {
      foldWindow(parts, s);
      continue;
    }
    // A name either by the chat's own capitalisation, or vouched for by the
    // news cycle: "andy burnham" in a headline confirms the merge even when
    // commenters type it lowercase and the caps signal never fires.
    const isName = s.caps / s.recent >= 0.6 || (corpus?.phrases.has(key) ?? false);

    // Decide before mutating anything: a phrase either speaks for a bare word,
    // or the bare word speaks for it. Showing both is the redundancy that put
    // "bbq's" and "disposable BBQ" in the row as separate topics.
    const absorbs = new Map<string, Stat>();
    let redundant = false;
    for (const part of parts) {
      const u = uni.get(part);
      if (!u) continue;
      // The phrase leads when it accounts for a fair share of the word's
      // mentions; a name leads over its own shorter form at any share, since
      // "Stadlen" and "Matthew Stadlen" are unambiguously one person.
      if (s.recent >= 0.4 * u.recent || (isName && u.recent >= s.recent)) {
        absorbs.set(part, u);
      } else if (u.recent > s.recent) {
        // The bare word is the bigger topic and its count already includes
        // every comment this phrase matched — the phrase adds nothing.
        redundant = true;
      }
    }
    if (redundant) {
      // The bare word wins, but the phrase's other word ("disposable" of
      // "disposable BBQ") lives only inside this phrase — on its own it is a
      // meaningless chip, so let it go with the phrase.
      for (const part of absorbs.keys()) consumed.add(part);
      continue;
    }

    let recent = s.recent;
    let sc = score(s) * 1.6 * corpusBoost(key);
    for (const [part, u] of absorbs) {
      consumed.add(part);
      // Whatever absorbs a word inherits its weight — otherwise a topic
      // mentioned a dozen times is displayed with the phrase's small count.
      recent = Math.max(recent, u.recent);
      sc = Math.max(sc, score(u));
    }
    const biWord = bestForm(s.forms) ?? key;
    candidates.push({
      word: biWord,
      recent,
      prior: s.prior,
      score: sc,
      authors: s.authors.size,
      parts,
      pattern: numberAwarePattern(key, biWord),
    });
    spanAnchors.push({ parts, s });
    for (const w of parts) claimed.add(w);
  }

  // Connective phrases earn a slot only when ≥2 distinct people used the exact
  // bridged phrase AND both endpoints are themselves trending — so it surfaces
  // "stop the boats" by uniting two hot topics rather than inventing a phrase.
  const connectives: Trend[] = [];
  // The phrase's own mention count, kept apart from the merged `recent` above,
  // so a dropped phrase can tell which endpoints it actually speaks for.
  const rawCount = new Map<Trend, number>();
  for (const [key, s] of conn) {
    if (s.authors.size < 2) continue;
    const stems = key.split(" ");
    const head = uni.get(stems[0]!);
    const tail = uni.get(stems[stems.length - 1]!);
    if (!head || !tail || head.recent < 2 || tail.recent < 2) continue;
    const connWord = bestForm(s.forms) ?? key;
    const trend: Trend = {
      word: connWord,
      recent: Math.max(s.recent, head.recent, tail.recent),
      prior: s.prior,
      score: Math.max(score(s) * 1.8, score(head), score(tail)) * corpusBoost(key),
      authors: s.authors.size,
      parts: [stems[0]!, stems[stems.length - 1]!],
      pattern: numberAwarePattern(key, connWord),
    };
    rawCount.set(trend, s.recent);
    connectives.push(trend);
  }

  // Collapse overlapping fragments of the *same repeated sentence*. When ~7
  // people all post "Tucker Carlson is in bed with Dubai", the connectives
  // "Carlson is in bed" and "bed with Dubai" pile up beside the "Tucker Carlson"
  // bigram — three chips for one topic. Taking connectives strongest-first, we
  // keep one only if neither endpoint is already claimed (by a bigram or a
  // stronger connective).
  //
  // "Claimed" and "consumed" are deliberately different things. A dropped
  // phrase still *claims* its endpoints, so the next fragment of the same
  // sentence ("bed with Dubai" after "Carlson is in bed") can't chain off them
  // — but it must not *consume* them, because that also deleted the bare words
  // and a topic mentioned a dozen times could vanish behind a four-mention
  // phrase. Only a phrase that earns a chip suppresses the words it stands for.
  connectives.sort((a, b) => b.score - a.score);
  for (const p of connectives) {
    const parts = p.parts ?? [];
    const overlaps = parts.some((w) => claimed.has(w));
    for (const w of parts) claimed.add(w);

    if (overlaps) {
      // Dropped: suppress only the words this phrase effectively owns. "bed"
      // exists solely inside "…is in bed with Dubai" and is junk on its own,
      // whereas a word with a life of its own outside the phrase stays.
      const raw = rawCount.get(p) ?? 0;
      for (const w of parts) {
        const u = uni.get(w);
        if (u && raw >= 0.6 * u.recent) consumed.add(w);
      }
      continue;
    }

    for (const w of parts) consumed.add(w);
    candidates.push(p);
  }

  const singles: Trend[] = [];

  // Known entities: canonical label, alias-merged count, and an alias-aware
  // highlight/filter pattern. They already carry the strong proper-noun boost
  // (recorded with cap: true), so they rank like names without an extra nudge.
  for (const [key, s] of ent) {
    const trend: Trend = {
      word: bestForm(s.forms) ?? key,
      recent: s.recent,
      prior: s.prior,
      score: score(s) * corpusBoost(key.toLowerCase()),
      authors: s.authors.size,
      pattern: entityPattern(key),
    };
    (s.recent >= 2 ? candidates : singles).push(trend);
  }

  for (const [key, s] of uni) {
    if (consumed.has(key) || isBoilerplate(key)) continue;
    (s.recent >= 2 ? candidates : singles).push(toTrend(key, s, 1));
  }

  // A trend is "real" only with ≥2 distinct voices — one person can't make a
  // trend. Single-voice candidates and single-mention terms are filler: still
  // shown to keep the row from emptying when little is happening, but flagged
  // `weak` so the UI mutes them instead of passing them off as genuine trends.
  const real = candidates.filter((t) => (t.authors ?? 0) >= 2).sort((a, b) => b.score - a.score);
  const filler = [...candidates.filter((t) => (t.authors ?? 0) < 2), ...singles].sort((a, b) => b.score - a.score);

  const result = real.slice(0, limit);
  for (const t of filler) {
    if (result.length >= minTrends) break;
    result.push({ ...t, weak: true });
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
 * doesn't churn — while letting fresh topics lead. Ordering is real fresh
 * trends, then still-sticky faded ones, then single-voice filler as a last
 * resort — so a lingering real topic always beats fresh filler, and filler
 * never lingers (weak trends aren't persisted). Mutates `sticky`.
 */
export function mergeStickyTrends(
  fresh: Trend[],
  sticky: Map<string, StickyEntry>,
  now: number,
  opts: { stickyMs?: number; display?: number } = {},
): Trend[] {
  const stickyMs = opts.stickyMs ?? 180_000; // 3 minutes
  const display = opts.display ?? 6;

  // One identity per topic across spellings: "Saturday Five" and "SATURDAY 5"
  // normalize to the same key, so a display-form flip between ticks overwrites
  // the sticky slot instead of parking the old spelling beside the new chip.
  const stemKey = (word: string) => word.toLowerCase().split(/\s+/).map(normalize).join(" ");

  // Only real trends earn a dwell; filler is ephemeral (shown this tick or not).
  for (const t of fresh) if (!t.weak) sticky.set(stemKey(t.word), { until: now + stickyMs, trend: t });
  for (const [key, entry] of sticky) if (entry.until <= now) sticky.delete(key);

  // A merged topic replaces its fragments. When "Cambridge University" arrives,
  // a lingering sticky "Cambridge" is the same topic's short form — showing
  // both puts the merge and its leftovers side by side in the row. Any sticky
  // entry whose every word is contained in a fresh trend's words is dropped.
  for (const t of fresh) {
    const full = new Set(stemKey(t.word).split(" "));
    if (full.size < 2) continue; // single words can't subsume anything
    for (const key of [...sticky.keys()]) {
      if (key === stemKey(t.word)) continue;
      const parts = key.split(" ");
      if (parts.length < full.size && parts.every((w) => full.has(w))) sticky.delete(key);
    }
  }

  const freshKeys = new Set(fresh.map((t) => stemKey(t.word)));
  const faded = [...sticky.entries()]
    .filter(([key]) => !freshKeys.has(key))
    .map(([, entry]) => entry.trend)
    .sort((a, b) => b.score - a.score);
  const freshReal = fresh.filter((t) => !t.weak).sort((a, b) => b.score - a.score);
  const freshWeak = fresh.filter((t) => t.weak).sort((a, b) => b.score - a.score);

  // The row is deduped by the same normalized identity, so one topic renders
  // one chip whichever spelling each entry happens to carry.
  const seen = new Set<string>();
  const row: Trend[] = [];
  for (const t of [...freshReal, ...faded, ...freshWeak]) {
    const key = stemKey(t.word);
    if (seen.has(key)) continue;
    seen.add(key);
    row.push(t);
    if (row.length === display) break;
  }
  return row;
}
