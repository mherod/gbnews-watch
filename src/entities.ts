/**
 * A curated lexicon of stable, well-known named entities — abbreviations
 * (NHS, EU), countries, UK political parties, and a few persistent topics —
 * that the generic trend detector would otherwise miss or fragment.
 *
 * It does three jobs the plain word-counter can't:
 *   1. Surfaces short abbreviations the `length >= 3` filter drops (EU, GB, UK).
 *   2. Merges aliases into ONE canonical topic ("Tory"/"Tories" → "Conservative").
 *   3. Marks these as strong, real-world topics so they rank above generic words.
 *
 * "Constant" is the operative word: everything here is stable — it won't vanish
 * next week — which is what makes a hand-curated list safe. Ambiguity is the
 * enemy, so any alias that is also a common lowercase word ("reform" the verb,
 * "greens" the vegetable, country names that are also first names, "vat" the
 * container) carries `requireCaps`: it only counts when Capitalised.
 *
 * The bulk was harvested and adversarially ambiguity-vetted by a multi-agent
 * pass; a few precision calls (un/vat/Dover require caps; Rwanda added) are
 * deliberate overrides of that pass's recall-first defaults.
 *
 * Framework-free and pure so it unit-tests cleanly, and imports nothing from
 * `trending.ts` to avoid a cycle.
 */

export interface EntityAlias {
  /** Lowercase alias — one or two whitespace-separated words. */
  text: string;
  /** Must appear Capitalised in the comment to count (disambiguates common words). */
  requireCaps?: boolean;
}

export interface Entity {
  /** Canonical label shown on the chip; aliases upgrade to this. */
  canonical: string;
  category: "institution" | "country" | "party" | "other";
  aliases: EntityAlias[];
}

/** Convenience: an alias that only counts when Capitalised. */
const caps = (text: string): EntityAlias => ({ text, requireCaps: true });

export const BOILERPLATE_STEMS = new Set([
  "gbnews",
  "gbn",
  "gbfamily",
  "livestream",
]);

export const ENTITIES: Entity[] = [
  // ---- Institutions, bodies & abbreviations ----
  // All-caps forms match case-insensitively (commenters SHOUT and whisper both),
  // except where the lowercase form is a real word (vat, un).
  { canonical: "NHS", category: "institution", aliases: [{ text: "nhs" }] },
  { canonical: "EU", category: "institution", aliases: [{ text: "eu" }, { text: "european union" }] },
  { canonical: "UK", category: "institution", aliases: [{ text: "uk" }, { text: "united kingdom" }, caps("britain")] },
  { canonical: "GB News", category: "institution", aliases: [{ text: "gb news" }, { text: "gbnews" }] },
  { canonical: "The Sun", category: "institution", aliases: [{ text: "the sun" }] },
  { canonical: "GB", category: "institution", aliases: [{ text: "gb" }] }, // note: often GB News itself
  { canonical: "USA", category: "institution", aliases: [{ text: "usa" }, { text: "united states" }, caps("america")] },
  { canonical: "UN", category: "institution", aliases: [caps("un"), { text: "united nations" }] }, // caps: avoid "wrong'un"
  { canonical: "NATO", category: "institution", aliases: [{ text: "nato" }] },
  { canonical: "BBC", category: "institution", aliases: [{ text: "bbc" }] },
  { canonical: "ITV", category: "institution", aliases: [{ text: "itv" }] },
  { canonical: "Channel 4", category: "institution", aliases: [{ text: "channel 4" }, { text: "channel four" }] },
  { canonical: "Sky News", category: "institution", aliases: [{ text: "sky news" }] },
  { canonical: "Ofcom", category: "institution", aliases: [{ text: "ofcom" }] },
  { canonical: "Ofgem", category: "institution", aliases: [{ text: "ofgem" }] },
  { canonical: "HMRC", category: "institution", aliases: [{ text: "hmrc" }] },
  { canonical: "DWP", category: "institution", aliases: [{ text: "dwp" }] },
  { canonical: "DVLA", category: "institution", aliases: [{ text: "dvla" }] },
  { canonical: "VAT", category: "institution", aliases: [caps("vat")] }, // caps: avoid the container
  { canonical: "MP", category: "institution", aliases: [{ text: "mp" }, { text: "mps" }] },
  { canonical: "Home Office", category: "institution", aliases: [caps("home office")] }, // caps: WFH room
  { canonical: "Border Force", category: "institution", aliases: [{ text: "border force" }] },
  { canonical: "Met Office", category: "institution", aliases: [{ text: "met office" }] },
  { canonical: "Royal Navy", category: "institution", aliases: [{ text: "royal navy" }] },
  { canonical: "Buckingham Palace", category: "institution", aliases: [{ text: "buckingham palace" }] },
  { canonical: "Parliament", category: "institution", aliases: [{ text: "parliament" }] },
  { canonical: "Westminster", category: "institution", aliases: [{ text: "westminster" }] },
  { canonical: "Whitehall", category: "institution", aliases: [{ text: "whitehall" }] },
  { canonical: "Downing Street", category: "institution", aliases: [{ text: "downing street" }] },

  // ---- Countries & UK home nations (proper nouns → requireCaps) ----
  { canonical: "England", category: "country", aliases: [caps("england")] },
  { canonical: "Scotland", category: "country", aliases: [caps("scotland")] },
  { canonical: "Wales", category: "country", aliases: [caps("wales")] }, // note: also Prince/Princess of Wales
  { canonical: "Northern Ireland", category: "country", aliases: [caps("northern ireland"), caps("ulster")] },
  { canonical: "Ireland", category: "country", aliases: [caps("ireland")] },
  { canonical: "France", category: "country", aliases: [caps("france")] },
  { canonical: "Germany", category: "country", aliases: [caps("germany")] },
  { canonical: "Russia", category: "country", aliases: [caps("russia")] },
  { canonical: "Ukraine", category: "country", aliases: [caps("ukraine")] },
  { canonical: "China", category: "country", aliases: [caps("china")] },
  { canonical: "India", category: "country", aliases: [caps("india")] },
  { canonical: "Pakistan", category: "country", aliases: [caps("pakistan")] },
  { canonical: "Afghanistan", category: "country", aliases: [caps("afghanistan")] },
  { canonical: "Iran", category: "country", aliases: [caps("iran")] },
  { canonical: "Iraq", category: "country", aliases: [caps("iraq")] },
  { canonical: "Syria", category: "country", aliases: [caps("syria")] },
  { canonical: "Israel", category: "country", aliases: [caps("israel")] },
  { canonical: "Palestine", category: "country", aliases: [caps("palestine")] },
  { canonical: "Australia", category: "country", aliases: [caps("australia")] },
  { canonical: "Canada", category: "country", aliases: [caps("canada")] },
  { canonical: "Poland", category: "country", aliases: [caps("poland")] },
  { canonical: "Albania", category: "country", aliases: [caps("albania")] },
  { canonical: "Rwanda", category: "country", aliases: [caps("rwanda")] }, // added: deportation policy
  { canonical: "Somalia", category: "country", aliases: [caps("somalia")] },
  { canonical: "Eritrea", category: "country", aliases: [caps("eritrea")] },
  { canonical: "Sudan", category: "country", aliases: [caps("sudan")] },
  { canonical: "Nigeria", category: "country", aliases: [caps("nigeria")] },
  { canonical: "Turkey", category: "country", aliases: [caps("turkey")] }, // caps: the bird is lowercase

  // ---- UK political parties (canonical names fixed by the product owner) ----
  { canonical: "Labour", category: "party", aliases: [caps("labour"), { text: "labour party" }] },
  {
    canonical: "Conservative",
    category: "party",
    aliases: [caps("conservative"), caps("conservatives"), caps("tory"), caps("tories"), { text: "conservative party" }],
  },
  { canonical: "Reform UK", category: "party", aliases: [caps("reform"), { text: "reform uk" }] },
  {
    canonical: "Liberal Democrats",
    category: "party",
    aliases: [
      { text: "liberal democrats" },
      { text: "liberal democrat" },
      { text: "lib dem" },
      { text: "lib dems" },
      { text: "libdems" },
    ],
  },
  { canonical: "Green Party", category: "party", aliases: [{ text: "green party" }, caps("greens")] },
  { canonical: "SNP", category: "party", aliases: [{ text: "snp" }] },
  { canonical: "UKIP", category: "party", aliases: [{ text: "ukip" }] },
  { canonical: "DUP", category: "party", aliases: [caps("dup")] }, // caps: avoid "dup"/duplicate
  { canonical: "Plaid Cymru", category: "party", aliases: [{ text: "plaid cymru" }] },
  { canonical: "Sinn Féin", category: "party", aliases: [{ text: "sinn fein" }, { text: "sinn féin" }] },

  // ---- Other persistent topics ----
  { canonical: "Brexit", category: "other", aliases: [{ text: "brexit" }] },
  { canonical: "English Channel", category: "other", aliases: [{ text: "english channel" }, { text: "channel crossings" }] },
  { canonical: "Calais", category: "other", aliases: [caps("calais")] },
  { canonical: "Dover", category: "other", aliases: [caps("dover")] }, // caps: the port, not the fish
  { canonical: "Gaza", category: "other", aliases: [caps("gaza")] },
  { canonical: "ULEZ", category: "other", aliases: [{ text: "ulez" }] },
  { canonical: "Net Zero", category: "other", aliases: [{ text: "net zero" }, { text: "netzero" }] },
  { canonical: "Monarchy", category: "other", aliases: [{ text: "monarchy" }, { text: "royal family" }] },
];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface AliasEntry {
  canonical: string;
  requireCaps: boolean;
}

const SINGLE = new Map<string, AliasEntry>();
const DOUBLE = new Map<string, AliasEntry>();
const PATTERNS = new Map<string, string>();

for (const e of ENTITIES) {
  const forms = new Set<string>([e.canonical.toLowerCase()]);
  for (const a of e.aliases) {
    const key = a.text.trim().toLowerCase();
    const parts = key.split(/\s+/);
    const entry: AliasEntry = { canonical: e.canonical, requireCaps: !!a.requireCaps };
    if (parts.length === 1) {
      // Last writer wins; the synthesized list is de-conflicted so a single
      // alias never legitimately points at two canonicals.
      SINGLE.set(parts[0]!, entry);
    } else {
      DOUBLE.set(parts.slice(0, 2).join(" "), entry);
    }
    forms.add(key);
  }
  // Longest form first so a multi-word alias wins over a bare word in highlights.
  PATTERNS.set(
    e.canonical,
    [...forms].sort((a, b) => b.length - a.length).map(escapeRegex).join("|"),
  );
}

/** True when the token begins with an uppercase letter (NHS, Wales, Reform). */
export function startsUppercase(token: string): boolean {
  const c = token[0];
  return c !== undefined && c === c.toUpperCase() && c !== c.toLowerCase();
}

/** Light plural fold for alias lookup only ("Tories"→"tory", "MPs" stays). */
function entityStem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

export interface EntityHit {
  /** Canonical label to record. */
  canonical: string;
  /** Tokens consumed (1 or 2). */
  length: number;
}

/**
 * Try to match a known entity starting at `tokens[i]`, preferring a two-word
 * alias over a one-word one. `requireCaps` aliases only match when the token
 * starts uppercase, so "reform" the verb is ignored while "Reform" the party is
 * caught. Returns null when nothing matches.
 */
export function matchEntityAt(tokens: readonly string[], i: number): EntityHit | null {
  const t0 = tokens[i];
  if (t0 === undefined) return null;
  const lower0 = t0.toLowerCase();
  const cap0 = startsUppercase(t0);

  const t1 = tokens[i + 1];
  if (t1 !== undefined) {
    const d = DOUBLE.get(`${lower0} ${t1.toLowerCase()}`);
    if (d && (!d.requireCaps || cap0)) return { canonical: d.canonical, length: 2 };
  }

  const s = SINGLE.get(lower0) ?? SINGLE.get(entityStem(lower0));
  if (s && (!s.requireCaps || cap0)) return { canonical: s.canonical, length: 1 };

  return null;
}

/** Regex-source alternation of every form of an entity, for highlight/filter. */
export function entityPattern(canonical: string): string | undefined {
  return PATTERNS.get(canonical);
}
