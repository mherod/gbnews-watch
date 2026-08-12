/**
 * The GB News broadcast schedule, scraped from https://www.gbnews.com/watch/schedule.
 *
 * There is no public JSON endpoint: the complete multi-week schedule is
 * serialised into the page itself as `window.schedule_response = [...]` and the
 * date picker only filters that array client-side. Upstream (historically an
 * Azure Synapse → Logic App → API Management pipeline) emits a *JavaScript*
 * literal, not JSON — strings are single-quoted until a value contains an
 * apostrophe, then that one string is double-quoted instead, exactly like a
 * Python repr. `JSON.parse` therefore cannot read it; `parseLiteral` below is a
 * small recursive-descent parser for the subset the feed actually uses, plus
 * the Python spellings (`None`/`True`/`False`) the source has flip-flopped
 * through before.
 *
 * Known data quirks, all observed live and normalised here:
 * - The page claims "All times GMT" but summer timestamps carry `+01:00` (BST).
 *   The offsets are correct, the label is not — so times are parsed into Dates
 *   and the offset question disappears.
 * - `PresentersSectionIds` can repeat an id and can disagree in length with
 *   `Presenters` (deduped; never zipped with names).
 * - `ShowImage` sometimes doubles query separators (`&&width=600`).
 * - `ShowSectionId` is null for continuity slots (e.g. the national anthem),
 *   which can also be zero-duration (start === end).
 *
 * Pure and framework-free below `fetchSchedule`: the server owns caching, the
 * client only receives the normalised programmes.
 */

export const SCHEDULE_URL = "https://www.gbnews.com/watch/schedule";

export interface Programme {
  /** The schedule day this slot belongs to, as given (`YYYY-MM-DD`, UK-local). */
  date: string;
  start: Date;
  end: Date;
  title: string;
  /** As given upstream: "Live", "Replay" — treated as opaque. */
  type: string;
  /** Media-library URL with doubled `&&` separators repaired; null if absent. */
  image: string | null;
  presenters: string[];
  description: string;
  /** RebelMouse section id of the show; null for continuity slots. */
  showSectionId: number | null;
  /** RebelMouse section ids of the presenters, deduplicated. */
  presenterSectionIds: number[];
}

/** A programme as served over the API — dates as ISO strings (UTC). */
export interface WireProgramme extends Omit<Programme, "start" | "end"> {
  start: string;
  end: string;
}

export function programmeToWire(p: Programme): WireProgramme {
  return { ...p, start: p.start.toISOString(), end: p.end.toISOString() };
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  "0": "\0",
};

/**
 * Parses one value of the JS-literal subset the schedule uses: single- or
 * double-quoted strings with backslash escapes, numbers, arrays, objects
 * (quoted or bare keys), and null/booleans in both JSON and Python spellings.
 * Returns the value and the index just past it. Throws on anything else —
 * a partial schedule is worse than a loud failure.
 */
function parseLiteral(src: string, at: number): { value: unknown; end: number } {
  let i = at;

  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };

  const fail = (what: string): never => {
    throw new Error(`schedule literal: expected ${what} at ${i} (…${JSON.stringify(src.slice(i, i + 30))})`);
  };

  const parseString = (): string => {
    const quote = src[i]!;
    i++;
    let out = "";
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") {
        const next = src[i + 1]!;
        if (next === "u") {
          // Strict \uXXXX only — a malformed escape (or ES6 \u{...}) must
          // throw, not decode to garbage that a 30-minute cache then serves.
          const hex = src.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail("a \\uXXXX escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (next === "x") {
          const hex = src.slice(i + 2, i + 4);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) return fail("a \\xXX escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += ESCAPES[next] ?? next;
          i += 2;
        }
        continue;
      }
      if (c === quote) {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    return fail("closing quote");
  };

  const parseValue = (): unknown => {
    skipWs();
    const c = src[i];
    if (c === undefined) return fail("a value");
    if (c === "'" || c === '"') return parseString();
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      skipWs();
      if (src[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        skipWs();
        if (src[i] === ",") {
          i++;
          skipWs();
          if (src[i] === "]") {
            i++;
            return arr;
          }
          continue;
        }
        if (src[i] === "]") {
          i++;
          return arr;
        }
        return fail('"," or "]"');
      }
    }
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      skipWs();
      if (src[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        skipWs();
        let key: string;
        if (src[i] === "'" || src[i] === '"') key = parseString();
        else {
          const m = /^[\w$]+/.exec(src.slice(i));
          if (!m) return fail("an object key");
          key = m[0];
          i += m[0].length;
        }
        skipWs();
        if (src[i] !== ":") return fail('":"');
        i++;
        obj[key] = parseValue();
        skipWs();
        if (src[i] === ",") {
          i++;
          skipWs();
          if (src[i] === "}") {
            i++;
            return obj;
          }
          continue;
        }
        if (src[i] === "}") {
          i++;
          return obj;
        }
        return fail('"," or "}"');
      }
    }
    const word = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|null|true|false|None|True|False)/.exec(src.slice(i));
    if (!word) return fail("a value");
    i += word[0].length;
    switch (word[0]) {
      case "null":
      case "None":
        return null;
      case "true":
      case "True":
        return true;
      case "false":
      case "False":
        return false;
      default:
        return Number(word[0]);
    }
  };

  const value = parseValue();
  return { value, end: i };
}

/**
 * Pulls the raw `window.schedule_response` array out of the page HTML.
 * The parser consumes exactly one balanced value, so nothing after the array
 * (the inline `.sort()` call, `window.show_urls`, …) needs to be delimited.
 */
export function extractScheduleArray(html: string): unknown[] {
  const m = /window\.schedule_response\s*=\s*/.exec(html);
  if (!m) throw new Error("schedule page: window.schedule_response assignment not found");
  const { value } = parseLiteral(html, m.index + m[0].length);
  if (!Array.isArray(value)) throw new Error("schedule page: schedule_response is not an array");
  return value;
}

const asString = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Numbers, or the numeric strings the feed has historically sent instead. */
const asId = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
};

const asDate = (v: unknown): Date | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * One raw record → one Programme, or null when it lacks the title/start/end
 * that make a slot placeable at all. Everything else degrades gracefully.
 */
export function normalizeProgramme(raw: unknown): Programme | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const title = asString(r.ShowTitle);
  const start = asDate(r.StartDateTime);
  const end = asDate(r.EndDateTime);
  if (!title || !start || !end) return null;

  // ProgramDate is the grouping key the site's own date picker uses; the local
  // date prefix of StartDateTime is the same value when it goes missing.
  const date = asString(r.ProgramDate) ?? (r.StartDateTime as string).slice(0, 10);

  const presenters = (Array.isArray(r.Presenters) ? r.Presenters : [r.Presenters])
    .flatMap((p) => (typeof p === "string" ? p.split(",") : []))
    .map((p) => p.trim())
    .filter((p) => p !== "");

  const presenterSectionIds = [
    ...new Set(
      (Array.isArray(r.PresentersSectionIds) ? r.PresentersSectionIds : [r.PresentersSectionIds])
        .map(asId)
        .filter((id): id is number => id !== null),
    ),
  ];

  const image = asString(r.ShowImage)?.replace(/&{2,}/g, "&") ?? null;

  return {
    date,
    start,
    end,
    title,
    type: asString(r.ShowType) ?? "",
    image,
    presenters,
    description: asString(r.Description) ?? "",
    showSectionId: asId(r.ShowSectionId),
    presenterSectionIds,
  };
}

/** The full pipeline: page HTML → normalised programmes, sorted by start. */
export function parseSchedulePage(html: string): Programme[] {
  return extractScheduleArray(html)
    .map(normalizeProgramme)
    .filter((p): p is Programme => p !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * The programme on air at `when` — start inclusive, end exclusive, so a
 * zero-duration continuity slot never claims the moment and back-to-back
 * slots never both match. Overlaps resolve to the latest-starting slot,
 * which is the more specific one. Order-independent: the injectable
 * `schedule` seam means input isn't guaranteed to arrive start-sorted,
 * and a full scan of a ~281-slot grid costs nothing.
 */
export function onAirAt(programmes: readonly Programme[], when: Date = new Date()): Programme | undefined {
  const t = when.getTime();
  let match: Programme | undefined;
  for (const p of programmes) {
    const s = p.start.getTime();
    if (s <= t && t < p.end.getTime() && (match === undefined || s >= match.start.getTime())) match = p;
  }
  return match;
}

/** Every programme the site would list under one `YYYY-MM-DD` picker date. */
export function programmesOn(programmes: readonly Programme[], date: string): Programme[] {
  return programmes.filter((p) => p.date === date);
}

/**
 * Fetches and parses the live schedule. No retries or caching here — the
 * server layer owns cadence, exactly as it does for the RSS corpus.
 */
export async function fetchSchedule(timeoutMs = 15_000): Promise<Programme[]> {
  const res = await fetch(SCHEDULE_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "text/html" },
  });
  if (!res.ok) throw new Error(`schedule page responded ${res.status}`);
  return parseSchedulePage(await res.text());
}
