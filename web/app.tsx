import {
  memo,
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";

import type { WireProgramme } from "../src/schedule";
import type { ServerMessage, Stats, WireComment } from "../src/wire";
import { computeTrends, mergeStickyTrends, termRegex, type StickyEntry, type Trend } from "../src/trending";
import { roomMood, emojiSentiment, LEXICON, type Mood } from "../src/sentiment";
import { isEmoji, topEmoji, type EmojiCount } from "../src/emoji";
import type { TopicGraph } from "../src/graph";
import {
  canonicalizeTrends,
  deserializeMemory,
  emptyMemory,
  memoryToGraph,
  type TopicMemory,
} from "../src/memory";
import { entityPattern, registerPresenterEntities } from "../src/entities";
import { Constellation } from "./constellation";
import { UnionJack } from "./union-jack";
import { UnionJackBackdrop } from "./union-jack-backdrop";
import { motion, AnimatePresence } from "framer-motion";

/** How often the shared server-side memory is re-fetched. */
const ROOM_POLL_MS = 8_000;

/**
 * How often the broadcast grid is re-fetched. The route serves a 30-minute
 * server-side cache behind Cache-Control max-age=60, so polling faster than
 * this buys nothing; programme handovers are computed client-side between
 * polls, so they still flip on the second.
 */
const SCHEDULE_POLL_MS = 5 * 60_000;

const FEED_LIMIT = 150;
/** Rolling window the activity sparkline covers. */
const SPARK_WINDOW_MS = 90_000;
const SPARK_BUCKETS = 30;

// ---------------------------------------------------------------- helpers

/** Keep the first occurrence of each comment uuid, preserving order. */
function dedupe(comments: WireComment[]): WireComment[] {
  const seen = new Set<string>();
  return comments.filter((c) => (seen.has(c.uuid) ? false : (seen.add(c.uuid), true)));
}

const UK_REGIONS = [
  "London & Westminster",
  "Yorkshire & Humber",
  "Manchester & North West",
  "West Midlands",
  "East Anglia",
  "The West Country",
  "Scottish Highlands",
  "Wales & The Valleys",
  "Tyne & Wear",
  "Kent & South Coast",
  "Cotswolds & Heart of England",
];

function authorRegion(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return UK_REGIONS[h % UK_REGIONS.length]!;
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words[0]![0]! + (words[1]?.[0] ?? "")).toUpperCase();
}

/** Regimental-tie catalogue — distinct correspondents, one heraldic family. */
const SWATCHES = ["#012169", "#264fa3", "#3f5e8c", "#c8102e", "#93273a", "#00782a", "#2f6f73", "#5a5f6e"];

function swatchOf(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return SWATCHES[h % SWATCHES.length]!;
}

function avatarStyle(name: string) {
  return { background: swatchOf(name) };
}

/** Compact, ticks-every-second relative time. */
function relativeTime(ms: number, now: number) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function absoluteTime(ms: number) {
  return new Date(ms).toLocaleString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "short",
  });
}

/** Eases a displayed number toward a target so stat changes roll rather than jump. */
function useCountUp(value: number) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef<number | undefined>(undefined);

  useEffect(() => {
    const start = performance.now();
    const startValue = from.current;
    const delta = value - startValue;
    if (delta === 0) return;
    const duration = Math.min(600, 120 + Math.abs(delta) * 40);

    const step = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - (1 - p) ** 3;
      setShown(Math.round(startValue + delta * eased));
      if (p < 1) raf.current = requestAnimationFrame(step);
      else from.current = value;
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      from.current = value;
    };
  }, [value]);

  return shown;
}

// ---------------------------------------------------------------- data hook

interface FeedState {
  comments: WireComment[];
  stats: Stats;
  connected: boolean;
  /** Arrival wall-clock times (ms) within the sparkline window. */
  arrivals: number[];
  peakPerMinute: number;
}

function useCommentFeed(): FeedState {
  const [comments, setComments] = useState<WireComment[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, perMinute: 0, upstream: "connecting", clients: 0 });
  const [connected, setConnected] = useState(false);
  const [arrivals, setArrivals] = useState<number[]>([]);
  const [peakPerMinute, setPeak] = useState(0);
  const retries = useRef(0);

  const recordArrival = () => {
    const cutoff = Date.now() - SPARK_WINDOW_MS;
    setArrivals((current) => [...current.filter((t) => t >= cutoff), Date.now()]);
  };

  useEffect(() => {
    setPeak((p) => Math.max(p, stats.perMinute));
  }, [stats.perMinute]);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pollInterval: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    const pollHealth = async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) return;
        const data = await res.json();
        if (data.comments) setComments(dedupe(data.comments).slice(0, FEED_LIMIT));
        setStats({
          total: data.total ?? 0,
          perMinute: data.perMinute ?? 0,
          upstream: data.upstream ?? "live",
          clients: data.clients ?? 1,
        });
        setConnected(true);
      } catch {
        // network error during poll
      }
    };

    const connect = () => {
      if (closed) return;
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${location.host}/ws`);

      socket.onopen = () => {
        retries.current = 0;
        setConnected(true);
        if (pollInterval) clearInterval(pollInterval);
      };

      socket.onmessage = (event) => {
        const message: ServerMessage = JSON.parse(event.data);
        setStats(message.stats);
        if (message.type === "snapshot") setComments(dedupe(message.comments).slice(0, FEED_LIMIT));
        if (message.type === "comment") {
          const incoming = message.comment;
          setComments((current) => {
            // The same comment can arrive twice (socket + poll, or a re-broadcast);
            // keep one copy so React keys stay unique and the feed doesn't repeat.
            if (current.some((c) => c.uuid === incoming.uuid)) return current;
            return [incoming, ...current].slice(0, FEED_LIMIT);
          });
          recordArrival();
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        if (!pollInterval) {
          pollHealth();
          pollInterval = setInterval(pollHealth, 3000);
        }
        retry = setTimeout(connect, Math.min(8000, 500 * 2 ** retries.current++));
      };

      socket.onerror = () => socket?.close();
    };

    connect();
    pollHealth();
    pollInterval = setInterval(pollHealth, 3000);

    return () => {
      closed = true;
      clearTimeout(retry);
      if (pollInterval) clearInterval(pollInterval);
      if (!socket) return;
      socket.onclose = null;
      const target = socket;
      if (target.readyState === WebSocket.CONNECTING) {
        target.addEventListener("open", () => target.close(), { once: true });
      } else if (target.readyState === WebSocket.OPEN) {
        target.close();
      }
    };
  }, []);

  return { comments, stats, connected, arrivals, peakPerMinute };
}

/**
 * Whether the sticky masthead should yield viewport back to the feed. Two
 * thresholds (condense past 90, expand above 40) so the boundary can't
 * flicker; rAF-throttled passive listener so scrolling stays cheap.
 */
function useCondensedMasthead() {
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setCondensed((c) => (c ? window.scrollY > 40 : window.scrollY > 90));
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  return condensed;
}

/** Shared 1s clock so relative times stay fresh without per-comment timers. */
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Recomputes trending words every few seconds, off the render/time path. A
 * topic stays in the row for a dwell time after it stops trending (so the bar
 * doesn't flicker) while fresh topics still lead — via a sticky map kept in a
 * ref across ticks.
 */
/**
 * News-cycle vocabulary from the server's cached RSS parse. Detection weight
 * only — nothing from the feed is rendered. Refreshed on the feed's own cadence;
 * failures leave the empty corpus and the detector simply works unaided.
 */
function useCorpus() {
  const corpus = useRef<{ stems: Set<string>; phrases: Set<string> }>({
    stems: new Set(),
    phrases: new Set(),
  });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/corpus");
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        corpus.current = {
          stems: new Set(Array.isArray(json.stems) ? json.stems : []),
          phrases: new Set(Array.isArray(json.phrases) ? json.phrases : []),
        };
      } catch {
        /* offline or blocked — trends work without the corpus */
      }
    };
    load();
    const timer = setInterval(load, 10 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return corpus;
}

type CorpusRef = ReturnType<typeof useCorpus>;

/**
 * The broadcast grid from the server's cached scrape of /watch/schedule.
 * Fetch failures keep the previous grid; an empty grid simply renders no
 * on-air strip, so the feed never depends on the schedule being reachable.
 */
function useSchedule(): WireProgramme[] {
  const [programmes, setProgrammes] = useState<WireProgramme[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/schedule");
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        if (Array.isArray(json.programmes)) {
          // Register before rendering so the host machinery and trend
          // detector already know every billed presenter's aliases.
          registerPresenterEntities(
            json.programmes.flatMap((p: WireProgramme) => p.presenters ?? []),
          );
          setProgrammes(json.programmes);
        }
      } catch {
        /* offline — keep showing the last grid we fetched */
      }
    };
    load();
    const timer = setInterval(load, SCHEDULE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return programmes;
}

/**
 * The programme on air at `now` — the client-side twin of the server's
 * onAirAt, over wire timestamps: start inclusive, end exclusive, overlaps to
 * the latest-starting slot, any input order. Runs on the shared 1s clock so
 * handovers flip on time between schedule polls; a linear scan of a ~300-slot
 * grid each second costs nothing.
 */
function onAirNow(programmes: readonly WireProgramme[], now: number): WireProgramme | undefined {
  let match: WireProgramme | undefined;
  for (const p of programmes) {
    const s = Date.parse(p.start);
    if (s <= now && now < Date.parse(p.end) && (match === undefined || s >= Date.parse(match.start))) match = p;
  }
  return match;
}

function useTrends(
  comments: WireComment[],
  corpus: CorpusRef,
  memory: MutableRefObject<TopicMemory | null>,
) {
  const [trends, setTrends] = useState<Trend[]>([]);
  const latest = useRef(comments);
  latest.current = comments;
  const sticky = useRef<Map<string, StickyEntry>>(new Map());
  useEffect(() => {
    const compute = () => {
      const now = Date.now();
      let fresh = computeTrends(latest.current, now, { limit: 8, corpus: corpus.current });
      // The memory has already consolidated identities ("Burnham" is "Andy
      // Burnham") — adopt them so the row and the map tell one story.
      if (memory.current) fresh = canonicalizeTrends(memory.current, fresh);
      setTrends(mergeStickyTrends(fresh, sticky.current, now, { display: 6 }));
    };
    compute();
    const timer = setInterval(compute, 4000);
    return () => clearInterval(timer);
  }, []);
  return trends;
}

// ---------------------------------------------------------------- sparkline

function Sparkline({ arrivals, now }: { arrivals: number[]; now: number }) {
  const bars = useMemo(() => {
    const buckets = new Array(SPARK_BUCKETS).fill(0);
    const size = SPARK_WINDOW_MS / SPARK_BUCKETS;
    for (const t of arrivals) {
      const idx = SPARK_BUCKETS - 1 - Math.floor((now - t) / size);
      if (idx >= 0 && idx < SPARK_BUCKETS) buckets[idx]++;
    }
    return buckets;
  }, [arrivals, now]);

  const max = Math.max(1, ...bars);
  const w = 3;
  const gap = 1.5;
  const height = 22;
  const width = SPARK_BUCKETS * (w + gap);

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      {bars.map((v, i) => {
        const h = v === 0 ? 1.5 : Math.max(2, (v / max) * height);
        const fresh = i >= SPARK_BUCKETS - 2 && v > 0;
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={height - h}
            width={w}
            height={h}
            rx={1}
            className={fresh ? "spark__bar spark__bar--fresh" : "spark__bar"}
          />
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- comment

interface CommentView extends WireComment {
  timeMs: number;
  timeLabel: string;
  /** Body of the thread root, when we can attribute it to `replyingTo`. */
  parentQuote?: string;
  /** Set when this author has been posting frequently. */
  chatty?: { count: number; windowMin: number };
}

// A regex over the whole sentiment lexicon, built once.
const SENTIMENT_RE = new RegExp(
  `\\b(${Object.keys(LEXICON)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b`,
  "gi",
);
const hlSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Span = { start: number; end: number; kind: "trend" | "filter" | "pos" | "neg"; text: string };
// Trends are interactive, so they win any overlap; sentiment tints fill the gaps.
const SPAN_PRIORITY: Record<Span["kind"], number> = { filter: 0, trend: 1, neg: 2, pos: 2 };

/** A term to highlight: its display word plus an optional alias-aware regex source. */
type HlTerm = { word: string; pattern?: string };

/**
 * Renders a comment body with two kinds of highlight: trending terms (accent,
 * clickable to filter) and sentiment — negative words/emoji in red, positive in
 * green — so you can see at a glance where the heat is.
 */
function highlightBody(
  text: string,
  terms: readonly HlTerm[],
  filterLower: string | null,
  onTerm: (term: string) => void,
  hostRe: RegExp | null,
  exHostRe: RegExp | null,
): ReactNode {
  const spans: Span[] = [];

  // Trend terms — each matches its own word, or an alias-aware pattern for known
  // entities (so the "Conservative" chip lights up "Tory"). Longest source first
  // so multi-word/phrase forms win over their parts; entities with a pattern
  // bypass the length floor so short ones (EU) still highlight.
  const sources = terms
    .filter((t) => t.pattern !== undefined || t.word.length >= 3)
    .map((t) => t.pattern ?? t.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  if (sources.length > 0) {
    try {
      const re = new RegExp(`\\b(${sources.join("|")})\\b`, "gi");
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const isFilter = filterLower !== null && m[0].toLowerCase() === filterLower;
        spans.push({ start: m.index, end: m.index + m[0].length, kind: isFilter ? "filter" : "trend", text: m[0] });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    } catch {
      /* bad term → skip trend highlighting */
    }
  }

  if (spans.length === 0) return text;

  // Highest-priority spans first, then drop any that overlap an accepted one.
  spans.sort((a, b) => SPAN_PRIORITY[a.kind] - SPAN_PRIORITY[b.kind] || a.start - b.start);
  const chosen: Span[] = [];
  for (const s of spans) {
    if (!chosen.some((c) => s.start < c.end && c.start < s.end)) chosen.push(s);
  }
  chosen.sort((a, b) => a.start - b.start);

  const nodes: ReactNode[] = [];
  let last = 0;
  for (const s of chosen) {
    if (s.start > last) nodes.push(text.slice(last, s.start));
    const isFilter = s.kind === "filter";
    const isHost = !isFilter && hostRe !== null && hostRe.test(s.text);
    const isExHost = !isFilter && !isHost && exHostRe !== null && exHostRe.test(s.text);
    nodes.push(
      <mark
        key={s.start}
        className={isFilter ? "hl hl--filter" : isHost ? "hl hl--host" : isExHost ? "hl hl--exhost" : "hl"}
        role="button"
        tabIndex={0}
        aria-pressed={isFilter}
        aria-label={isFilter ? `Clear filter “${s.text}”` : `Filter comments to “${s.text}”`}
        onClick={(e) => {
          e.stopPropagation();
          onTerm(s.text);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          onTerm(s.text);
        }}
      >
        {s.text}
      </mark>,
    );
    last = s.end;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Comment body clamped to a few lines, expandable when it overflows. */
function CommentBody({ text, terms, termsKey, filterLower, onTerm, hostRe, exHostRe }: {
  text: string;
  terms: readonly HlTerm[];
  termsKey: string;
  filterLower: string | null;
  onTerm: (term: string) => void;
  hostRe: RegExp | null;
  exHostRe: RegExp | null;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return; // only measurable while clamped
    setOverflows(el.scrollHeight - el.clientHeight > 4);
  }, [text, expanded]);

  const content = useMemo(
    () => highlightBody(text, terms, filterLower, onTerm, hostRe, exHostRe),
    // termsKey stands in for the terms array; onTerm is stable.
    [text, termsKey, filterLower, onTerm, hostRe, exHostRe],
  );

  const clamped = !expanded;
  const className =
    "comment__body" +
    (clamped ? " comment__body--clamped" : "") +
    (clamped && overflows ? " comment__body--faded" : "");

  return (
    <>
      <p ref={ref} className={className}>
        {content}
      </p>
      {overflows && (
        <button
          type="button"
          className="comment__more"
          aria-expanded={expanded}
          title={expanded ? "Show fewer lines of this comment" : "Expand full comment body"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

const Comment = memo(function Comment({ c, terms, termsKey, filterLower, onTerm, hostRe, exHostRe }: {
  c: CommentView;
  terms: readonly HlTerm[];
  termsKey: string;
  filterLower: string | null;
  onTerm: (term: string) => void;
  hostRe: RegExp | null;
  exHostRe: RegExp | null;
}) {
  const isReply = c.kind === "reply";
  const style = avatarStyle(c.author);

  const scrollToParent = () => {
    if (!c.parentQuote) return;
    const el = document.getElementById(`c-${c.threadUuid}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("comment--flash");
    void el.offsetWidth;
    el.classList.add("comment--flash");
  };

  // The reply rail is a ::before pseudo-element tinted by this variable, not a
  // real child — so it can never become a stray grid item and break the layout.
  const liStyle = isReply
    ? ({ "--rail": swatchOf(c.author) } as CSSProperties)
    : undefined;

  return (
    <motion.li
      id={`c-${c.uuid}`}
      className={`comment${isReply ? " comment--reply" : ""}${c.isTopComment ? " comment--top" : ""}`}
      style={liStyle}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
    >
      {c.isTopComment && (
        <div className="comment__stamp" aria-hidden="true">
          <div className="stamp-seal">
            <span className="stamp-crown">♛</span>
            <span className="stamp-text">1st</span>
          </div>
        </div>
      )}
      <div className="avatar" style={style} aria-hidden="true">
        {initials(c.author)}
      </div>
      <div className="comment__main">
        <div className="comment__head">
          <span className="comment__author">{c.author}</span>
          <span className="postmark" title={`Franked in ${authorRegion(c.author)}`}>
            {authorRegion(c.author)}
          </span>
          {c.chatty && (
            <span
              className="chatty"
              title={`${c.chatty.count} dispatches in the last ${c.chatty.windowMin} min — rarely leaves the snug`}
            >
              Regular
            </span>
          )}
          {c.isPinned && <span className="tag tag--pin">Pinned</span>}
          {c.isEdited && <span className="comment__edited">amended</span>}
          <time className="comment__time" dateTime={new Date(c.timeMs).toISOString()} title={absoluteTime(c.timeMs)}>
            {c.timeLabel}
          </time>
        </div>

        {isReply && c.replyingTo && (
          <button
            type="button"
            className={`replyto${c.parentQuote ? " replyto--linked" : ""}`}
            onClick={scrollToParent}
            disabled={!c.parentQuote}
            title={
              c.parentQuote
                ? "Jump to the original comment"
                : "The original comment has scrolled out of the recent feed"
            }
          >
            <span className="replyto__arrow">↳</span>
            <span className="replyto__name">{c.replyingTo}</span>
            {c.parentQuote && <span className="replyto__quote">{c.parentQuote}</span>}
          </button>
        )}

        <CommentBody
          text={c.body.trim()}
          terms={terms}
          termsKey={termsKey}
          filterLower={filterLower}
          onTerm={onTerm}
          hostRe={hostRe}
          exHostRe={exHostRe}
        />

        <div className="comment__foot">
          <span
            className="stat stat--like"
            title={`${c.likes} in the gallery cried "Hear, hear!"`}
          >
            Hear, hear! {c.likes > 0 && <b>{c.likes}</b>}
          </span>
          {c.dislikes > 0 && (
            <span
              className="stat stat--rubbish"
              title={`${c.dislikes} listeners called rubbish`}
            >
              Tosh {c.dislikes}
            </span>
          )}
          {!isReply && c.replies > 0 && (
            <span className="stat stat--replies">
              ↳ {c.replies} {c.replies === 1 ? "rebuttal" : "rebuttals"}
            </span>
          )}
        </div>
      </div>
    </motion.li>
  );
});

// ---------------------------------------------------------------- header

function StatTile({ value, label, className }: { value: number; label: string; className?: string }) {
  const shown = useCountUp(value);
  return (
    <div className={`meter${className ? ` ${className}` : ""}`}>
      <b>{shown.toLocaleString("en-GB")}</b>
      <span>{label}</span>
    </div>
  );
}

const presenterList = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" });

function endTimeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * What the channel is broadcasting right now — the programme the room is
 * reacting to. Replays are labelled as such so a heated feed under a repeat
 * isn't mistaken for a reaction to live events.
 */
function OnAir({ programme, verdict, hostFirst, next }: {
  programme: WireProgramme | undefined;
  verdict: Mood | null;
  hostFirst: string | null;
  next: WireProgramme | undefined;
}) {
  if (!programme) return null;
  const live = programme.type.toLowerCase() === "live";
  return (
    <div className="onair" aria-live="polite" aria-atomic="true">
      <div className="onair__head">
        <span className={`onair__type${live ? " onair__type--live" : ""}`}>
          {programme.type || "On air"}
        </span>
        <b className="onair__title">{programme.title}</b>
        {programme.presenters.length > 0 && (
          <span className="onair__with">with {presenterList.format(programme.presenters)}</span>
        )}
        <span className="onair__until">until {endTimeLabel(programme.end)}</span>
      </div>
      {programme.description && <p className="onair__desc">{programme.description}</p>}
      {verdict && hostFirst && (
        <p
          className="onair__verdict"
          title={`Sentiment across recent dispatches mentioning ${hostFirst}`}
        >
          The room on {hostFirst}: <b className={`onair__verdict--${verdict.tone}`}>{verdict.label}</b>
        </p>
      )}
      {next && (
        <p className="onair__next" title={next.description || undefined}>
          Next: {next.title} · {endTimeLabel(next.start)}
        </p>
      )}
    </div>
  );
}

/** How long a ▲/▼ rank-change caret stays on a chip. */
const CARET_MS = 2600;

function TrendBar({ trends, filter, onToggle, emoji, host, hostActive }: {
  trends: Trend[];
  filter: string | null;
  onToggle: (word: string) => void;
  emoji: EmojiCount[];
  host: { display: string } | null;
  hostActive: boolean;
}) {
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const chipsRef = useRef<HTMLDivElement>(null);
  const prevLeft = useRef(new Map<string, number>());
  const prevRank = useRef(new Map<string, number>());
  const [moves, setMoves] = useState<Record<string, "up" | "down">>({});
  // Identity of the current order — the effect only runs when it actually changes.
  const order = trends.map((t) => t.word).join("|");

  // Edge fades on the scroller: a clipped chip with no cue reads as the end of
  // the list, so mark whichever edges still hide content. Written straight to
  // data attributes — scroll position isn't render state.
  const updateFades = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    const canScroll = el.scrollWidth - el.clientWidth > 1;
    el.dataset.fadeL = canScroll && el.scrollLeft > 1 ? "1" : "";
    el.dataset.fadeR = canScroll && el.scrollLeft < el.scrollWidth - el.clientWidth - 1 ? "1" : "";
  }, []);

  // Wired as a cleanup-returning callback ref, not a mount effect: the row
  // renders null until the first trends land, so a mount effect finds no
  // element and never retries. The ref runs at attach time, whenever that is.
  const wireFades = useCallback((el: HTMLDivElement) => {
    chipsRef.current = el;
    let raf = 0;
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        updateFades();
      });
    };
    updateFades();
    el.addEventListener("scroll", queue, { passive: true });
    const ro = new ResizeObserver(queue);
    ro.observe(el);
    return () => {
      chipsRef.current = null;
      el.removeEventListener("scroll", queue);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [updateFades]);

  // FLIP: the chips have already been laid out at their new positions, so we
  // invert each one back to where it was and let it play forward. Movement is
  // read from the DOM rather than tracked in state, so it stays correct when
  // chips are added, removed, or resized by a changing count.
  useLayoutEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const climbed: Record<string, "up" | "down"> = {};
    const words = new Set<string>();

    trends.forEach((t, i) => {
      words.add(t.word);
      const el = chipRefs.current.get(t.word);
      if (!el) return;
      const left = el.offsetLeft;
      const before = prevLeft.current.get(t.word);
      if (before !== undefined && Math.abs(before - left) > 1 && !reduce) {
        el.animate(
          [{ transform: `translateX(${before - left}px)` }, { transform: "translateX(0)" }],
          { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
      prevLeft.current.set(t.word, left);
      const was = prevRank.current.get(t.word);
      if (was !== undefined && was !== i) climbed[t.word] = i < was ? "up" : "down";
    });

    // Forget chips that have left the row so the maps don't grow unbounded.
    for (const key of [...prevLeft.current.keys()]) if (!words.has(key)) prevLeft.current.delete(key);
    for (const key of [...chipRefs.current.keys()]) if (!words.has(key)) chipRefs.current.delete(key);
    prevRank.current = new Map(trends.map((t, i) => [t.word, i]));

    if (Object.keys(climbed).length > 0) setMoves(climbed);
    // Chips joining or leaving change the content width without resizing the
    // container, which is the one case the ResizeObserver can't see.
    updateFades();
  }, [order, updateFades]);

  // Carets are a momentary signal, not a permanent badge — clear them.
  useEffect(() => {
    if (Object.keys(moves).length === 0) return;
    const id = setTimeout(() => setMoves({}), CARET_MS);
    return () => clearTimeout(id);
  }, [moves]);

  if (trends.length === 0 && emoji.length === 0 && !host) return null;
  // When every chip is single-voice filler, nothing is really trending — say so.
  const allWeak = trends.length > 0 && trends.every((t) => t.weak);
  return (
    <div className="trends" aria-label="Trending words">
      <span className="trends__label">Fleet Street Wire</span>
      {host && (
        <button
          type="button"
          className={`trends__chip trends__chip--host${hostActive ? " trends__chip--active" : ""}`}
          aria-pressed={hostActive}
          title={hostActive ? "Clear filter" : `Filter to dispatches mentioning ${host.display}`}
          onClick={() => onToggle(host.display)}
        >
          <i className="trends__hostdot" aria-hidden="true" />
          {host.display}
        </button>
      )}
      {allWeak && <span className="trends__quiet" title="No topic has caught on with more than one person yet">· quiet in the chamber</span>}
      <div className="trends__chips" ref={wireFades}>
        {trends.map((t) => {
          const active = filter?.toLowerCase() === t.word.toLowerCase();
          const moved = moves[t.word];
          return (
            <button
              key={t.word}
              ref={(el) => {
                if (el) chipRefs.current.set(t.word, el);
                else chipRefs.current.delete(t.word);
              }}
              type="button"
              className={`trends__chip${active ? " trends__chip--active" : ""}${t.weak ? " trends__chip--weak" : ""}`}
              aria-pressed={active}
              title={active ? `Clear filter` : t.weak ? `Only one voice so far — filter to “${t.word}”` : `Filter to “${t.word}”`}
              onClick={() => onToggle(t.word)}
            >
              {moved && (
                <b
                  className={`trends__caret trends__caret--${moved}`}
                  aria-label={moved === "up" ? "rising" : "falling"}
                >
                  {moved === "up" ? "▲" : "▼"}
                </b>
              )}
              {t.word}
              <i>{t.recent}</i>
            </button>
          );
        })}
      </div>
      {emoji.length > 0 && (
        <div className="trends__emoji" aria-label="Top emoji">
          {emoji.map((e) => {
            const active = filter === e.emoji;
            return (
              <button
                key={e.emoji}
                type="button"
                className={`emoji-chip${active ? " emoji-chip--active" : ""}`}
                aria-pressed={active}
                title={active ? "Clear filter" : `Filter to comments using ${e.emoji}`}
                onClick={() => onToggle(e.emoji)}
              >
                <span className="emoji-chip__glyph">{e.emoji}</span>
                <i>{e.count}</i>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Header({ stats, connected, arrivals, peak, now, trends, filter, onToggleFilter, mood, emoji, onAir, nextUp, host, hostActive, hostVerdict }: {
  stats: Stats;
  connected: boolean;
  arrivals: number[];
  peak: number;
  now: number;
  trends: Trend[];
  filter: string | null;
  onToggleFilter: (word: string) => void;
  mood: Mood | null;
  emoji: EmojiCount[];
  onAir: WireProgramme | undefined;
  nextUp: WireProgramme | undefined;
  host: { display: string; first: string } | null;
  hostActive: boolean;
  hostVerdict: Mood | null;
}) {
  const statusClass = connected && stats.upstream === "live"
    ? "status status--live"
    : connected
      ? "status"
      : "status status--down";
  const statusText = !connected ? "Disconnected" : stats.upstream === "live" ? "Live" : "Connecting";
  const condensed = useCondensedMasthead();

  return (
    <header className={`masthead${condensed ? " masthead--condensed" : ""}`}>
      <div className="masthead__row">
        <div className="masthead__title">
          <h1>
            <UnionJack width={28} height={14} />
            Have Your Say
          </h1>
          <p>
            Incorporating The Great British Public Forum · Est. this morning ·{" "}
            <a href="https://www.gbnews.com/watch/live" target="_blank" rel="noreferrer">
              gbnews.com/watch/live
            </a>
          </p>
        </div>
        <div className="meters">
          {(!connected || stats.upstream !== "live") && (
            <span className={statusClass}>
              <span className="status__dot" />
              {statusText}
            </span>
          )}
          {mood && (
            <span
              className={`mood mood--${mood.tone}`}
              title={`Room mood over ${mood.count} recent comments — ${Math.round(mood.negFrac * 100)}% negative, ${Math.round(mood.posFrac * 100)}% positive${mood.detail ? ` · ${mood.detail}` : ""}`}
            >
              {mood.label}
            </span>
          )}
          {stats.clients > 0 && <StatTile value={stats.clients} label="in the gallery" className="meter--accent" />}
          <div className="meter meter--rate">
            <div className="meter__rateline">
              <b>{stats.perMinute}</b>
              <Sparkline arrivals={arrivals} now={now} />
            </div>
            <span title={peak > 0 ? `peak ${peak} per min` : undefined}>per min</span>
          </div>
          <StatTile value={stats.total} label="dispatches" />
        </div>
      </div>
      <OnAir programme={onAir} verdict={hostVerdict} hostFirst={host?.first ?? null} next={nextUp} />
      <TrendBar trends={trends} filter={filter} onToggle={onToggleFilter} emoji={emoji} host={host} hostActive={hostActive} />
    </header>
  );
}

// ---------------------------------------------------------------- app

function App() {
  const { comments, stats, connected, arrivals, peakPerMinute } = useCommentFeed();
  const now = useNow(1000);
  const corpus = useCorpus();
  const programmes = useSchedule();
  // Cheap enough to run on the 1s clock — this is what makes a handover flip
  // on time even though the grid itself is only polled every few minutes.
  const onAir = onAirNow(programmes, now);

  // The broadcaster on air, as a matchable identity: full names plus first and
  // last names of every billed presenter, longest-first so whole names win.
  // Everything host-aware on the page (highlights, the pinned wire chip, the
  // landlord node, the verdict) derives from this one object. The memo keys on
  // a flat string so a fresh programmes array with the same billing is a no-op.
  const presenterKey = (onAir?.presenters ?? []).map((n) => n.trim()).filter(Boolean).join("\n");
  const host = useMemo(() => {
    const names = presenterKey ? presenterKey.split("\n") : [];
    if (names.length === 0) return null;
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = new Set<string>();
    for (const n of names) {
      parts.add(esc(n));
      const words = n.split(/\s+/);
      if (words.length > 1) {
        parts.add(esc(words[0]!));
        parts.add(esc(words[words.length - 1]!));
      }
    }
    // Corpus aliases count as mentions too — "Chopper" is Christopher Hope.
    for (const n of names) {
      const ep = entityPattern(n);
      if (ep) parts.add(ep);
    }
    const pattern = [...parts].sort((a, b) => b.length - a.length).join("|");
    return {
      display: names[0]!,
      first: names[0]!.split(/\s+/)[0]!,
      pattern,
      re: new RegExp(`\\b(${pattern})\\b`, "i"),
    };
  }, [presenterKey]);

  // How the room is taking the host: share of recent dispatches that mention
  // them, and the mood across just those dispatches. The verdict gets the same
  // hysteresis as the room pill — declared here so it precedes its use.
  const hostToneRef = useRef<Mood["tone"] | undefined>(undefined);
  const hostStats = useMemo(() => {
    if (!host || !onAir || comments.length === 0) return null;
    // Only dispatches posted since this programme began count against this
    // host — Tom doesn't inherit Patrick's hecklers.
    const startMs = Date.parse(onAir.start);
    const during = Number.isFinite(startMs)
      ? comments.filter((c) => new Date(c.postedAt).getTime() >= startMs)
      : comments;
    if (during.length === 0) return null;
    const mentioning = during.filter((c) => host.re.test(c.body));
    const share = Math.round((mentioning.length / during.length) * 100);
    const mood = roomMood(mentioning, Date.now(), {
      windowMs: 600_000,
      minScored: 3,
      previousTone: hostToneRef.current,
    });
    if (mood) hostToneRef.current = mood.tone;
    return { share, mood };
  }, [comments, host, onAir]);

  // Handovers observed while this tab was open — each becomes an
  // edition-change rule in the feed at the second the billing flipped.
  const [handovers, setHandovers] = useState<{ at: number; title: string; presenter?: string }[]>([]);
  const prevProgrammeRef = useRef<string | null>(null);
  useEffect(() => {
    const title = onAir?.title ?? null;
    if (title !== null && prevProgrammeRef.current !== null && title !== prevProgrammeRef.current && onAir) {
      const at = Date.parse(onAir.start);
      setHandovers((h) =>
        [...h, { at: Number.isFinite(at) ? at : Date.now(), title, presenter: onAir.presenters[0] }].slice(-4),
      );
    }
    if (title !== null) prevProgrammeRef.current = title;
  }, [onAir]);

  // The previous host keeps a dimmed highlight for a while after handover, so
  // the subject of half the thread doesn't vanish mid-conversation.
  const prevHostRef = useRef<typeof host>(null);
  const [exHost, setExHost] = useState<{ h: NonNullable<typeof host>; until: number } | null>(null);
  useEffect(() => {
    const prev = prevHostRef.current;
    if (prev && host && prev.display !== host.display) {
      setExHost({ h: prev, until: Date.now() + 15 * 60_000 });
    }
    prevHostRef.current = host;
  }, [host]);
  const exHostActive = exHost && exHost.until > now && (!host || exHost.h.display !== host.display) ? exHost.h : null;

  // The shared association memory, learned server-side from every comment —
  // even while nobody watches — and identical for every visitor. Created
  // before the trends hook because fresh trends are canonicalised against it:
  // the memory knows "Burnham" is "Andy Burnham", and the row should say what
  // the map says. Starts empty and fills from the first poll.
  const memoryRef = useRef<TopicMemory | null>(null);
  if (memoryRef.current === null) {
    memoryRef.current = emptyMemory(Date.now());
    // The graph no longer lives per-browser; clear the orphaned local copies.
    try {
      localStorage.removeItem("gbnews-watch:topic-memory:v2");
      localStorage.removeItem("gbnews-watch:topic-memory:v3");
    } catch {
      /* storage blocked — nothing to clean */
    }
  }

  const trends = useTrends(comments, corpus, memoryRef);

  // The host owns a pinned chip on the wire, so alias fragments of their name
  // ("Patrick Ask") come out of the ordinary trend row.
  const wireTrends = useMemo(
    () => (host ? trends.filter((t) => !host.re.test(t.word)) : trends),
    [trends, host],
  );

  // What follows this programme — the listings line at the foot of the billing.
  const nextUp = useMemo(() => {
    let best: WireProgramme | undefined;
    for (const p of programmes) {
      const s = Date.parse(p.start);
      if (s > now && (!best || s < Date.parse(best.start))) best = p;
    }
    return best;
  }, [programmes, now]);
  // The filter arrives from the URL so a shared or reloaded link reopens the
  // same slice of the room; every toggle is folded back into ?f= below.
  const [filter, setFilter] = useState<string | null>(
    () => new URLSearchParams(location.search).get("f"),
  );
  const toggleFilter = useCallback((word: string) => {
    setFilter((cur) => (cur && cur.toLowerCase() === word.toLowerCase() ? null : word));
  }, []);

  // replaceState, not pushState: chip toggles are rapid-fire, and a back
  // button that unwinds twelve filters one by one would read as broken.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (filter) params.set("f", filter);
    else params.delete("f");
    const qs = params.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }, [filter]);

  // Terms to highlight inside comment bodies: the current trends (with their
  // alias-aware entity patterns) plus the active filter. termsKey is a stable
  // string so the per-comment highlight memo only recomputes when the set
  // actually changes.
  const highlightTerms = useMemo<HlTerm[]>(() => {
    const map = new Map<string, HlTerm>();
    for (const t of trends) map.set(t.word.toLowerCase(), { word: t.word, pattern: t.pattern });
    // The host is always a highlight term while on air, alias-aware; the
    // previous host stays a (dimmed) term through the handover cooldown.
    if (host) map.set(host.display.toLowerCase(), { word: host.display, pattern: host.pattern });
    if (exHostActive && !map.has(exHostActive.display.toLowerCase())) {
      map.set(exHostActive.display.toLowerCase(), { word: exHostActive.display, pattern: exHostActive.pattern });
    }
    // Word filters join the highlight set; an emoji filter doesn't (it's tinted already).
    if (filter && !isEmoji(filter) && !map.has(filter.toLowerCase())) map.set(filter.toLowerCase(), { word: filter });
    return [...map.values()];
  }, [trends, filter, host, exHostActive]);
  const termsKey = highlightTerms.map((t) => t.pattern ?? t.word).join("|").toLowerCase();
  const filterLower = filter?.toLowerCase() ?? null;
  // Resolve an active filter to its entity pattern so filtering by "Conservative"
  // also catches "Tory".
  const filterPattern = useMemo(() => {
    if (!filterLower) return undefined;
    const fromTrends = trends.find((t) => t.word.toLowerCase() === filterLower)?.pattern;
    if (fromTrends) return fromTrends;
    // Filtering by the host (chip or highlight) catches every alias — the
    // outgoing host too, through the cooldown.
    if (host && host.re.test(filterLower)) return host.pattern;
    if (exHostActive && exHostActive.re.test(filterLower)) return exHostActive.pattern;
    return undefined;
  }, [trends, filterLower, host, exHostActive]);

  // The tab strip is a surface too: name the slice being watched, else the
  // programme being reacted to, so the tab is findable across a wall of tabs.
  useEffect(() => {
    document.title = filter
      ? `“${filter}” — Have Your Say`
      : onAir
        ? `${onAir.title} — Have Your Say`
        : "Have Your Say — live";
  }, [filter, onAir?.title]);

  // Room mood — recompute when the comment set changes (not every second tick).
  // The last tone shown is fed back in so a balance hovering on a boundary
  // holds its label instead of flapping between two readings.
  const moodToneRef = useRef<Mood["tone"] | undefined>(undefined);
  const mood = useMemo(() => {
    const next = roomMood(comments, Date.now(), {
      windowMs: 300_000,
      minScored: 4,
      previousTone: moodToneRef.current,
    });
    if (next) moodToneRef.current = next.tone;
    return next;
  }, [comments]);
  const emoji = useMemo(() => topEmoji(comments, Date.now(), { limit: 3 }), [comments]);
  const [showRoom, setShowRoom] = useState(true);

  // Unlike a rolling window the memory is never rebuilt: each new comment
  // reinforces the links it contains and everything decays with a half-life,
  // so the map keeps learning. Persisted so a reload resumes, not restarts.
  const [graph, setGraph] = useState<TopicGraph>({ nodes: [], links: [] });

  // Latest values for the poll loop, which must not restart on every tick.
  const trendsRef = useRef(trends);
  trendsRef.current = trends;
  const showRoomRef = useRef(showRoom);
  showRoomRef.current = showRoom;

  const rebuildGraph = useCallback(() => {
    const mem = memoryRef.current;
    if (!mem || !showRoomRef.current) return;
    // A phone-width canvas can't hold a desktop number of bodies legibly.
    const maxNodes = window.innerWidth < 560 ? 7 : window.innerWidth < 900 ? 11 : 14;
    setGraph(memoryToGraph(mem, { maxNodes, live: new Set(trendsRef.current.map((t) => t.word.toLowerCase())) }));
  }, []);

  // Poll the shared memory the server is learning. Reinforcement no longer
  // happens here — the server sees every comment whether or not a tab is open,
  // and every visitor renders this same graph.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/room");
        if (!res.ok || cancelled) return;
        memoryRef.current = deserializeMemory(JSON.stringify(await res.json()), Date.now());
        rebuildGraph();
      } catch {
        /* offline — keep showing the last graph we fetched */
      }
    };
    load();
    const timer = setInterval(load, ROOM_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rebuildGraph]);

  // Between polls, keep the live-topic emphasis and the show/hide state fresh.
  useEffect(() => {
    rebuildGraph();
  }, [trends, showRoom, rebuildGraph]);

  // Attribute a reply to its thread root's body only when the root is in view
  // and its author matches — otherwise the quote could mislabel a sibling reply.
  const views: CommentView[] = useMemo(() => {
    const CHATTY_WINDOW_MS = 5 * 60_000;
    const CHATTY_MIN = 3;

    // Per author: post times within the recent window, to flag frequent posters.
    const byAuthor = new Map<string, number[]>();
    for (const c of comments) {
      const t = new Date(c.postedAt).getTime();
      if (now - t > CHATTY_WINDOW_MS) continue;
      const times = byAuthor.get(c.author);
      if (times) times.push(t);
      else byAuthor.set(c.author, [t]);
    }
    const chattyByAuthor = new Map<string, { count: number; windowMin: number }>();
    for (const [author, times] of byAuthor) {
      if (times.length < CHATTY_MIN) continue;
      const windowMin = Math.max(1, Math.round((now - Math.min(...times)) / 60_000));
      chattyByAuthor.set(author, { count: times.length, windowMin });
    }

    const byUuid = new Map(comments.map((c) => [c.uuid, c]));
    return comments.map((c) => {
      const timeMs = new Date(c.postedAt).getTime();
      let parentQuote: string | undefined;
      if (c.kind === "reply") {
        const root = byUuid.get(c.threadUuid);
        if (root && root.author === c.replyingTo) parentQuote = root.body.trim().replace(/\s+/g, " ");
      }
      return {
        ...c,
        timeMs,
        timeLabel: relativeTime(timeMs, now),
        parentQuote,
        chatty: chattyByAuthor.get(c.author),
      };
    });
  }, [comments, now]);

  const filtered = useMemo(() => {
    if (!filter) return views;
    if (isEmoji(filter)) {
      // Emoji don't sit on word boundaries — match the raw grapheme in the body.
      return views.filter((v) => v.body.includes(filter));
    }
    const re = termRegex(filter, filterPattern);
    return views.filter(
      (v) => re.test(v.body) || re.test(v.author) || (v.replyingTo ? re.test(v.replyingTo) : false),
    );
  }, [views, filter, filterPattern]);

  const replyShare = comments.length
    ? Math.round((comments.filter((c) => c.kind === "reply").length / comments.length) * 100)
    : 0;

  // Comments and handover rules merged newest-first; on a tie the comment
  // (posted after the flip) sits above the rule it belongs to.
  const feedItems = useMemo(() => {
    type FeedItem =
      | { kind: "comment"; at: number; c: CommentView }
      | { kind: "handover"; at: number; title: string; presenter?: string };
    const oldest = filtered.length > 0 ? filtered[filtered.length - 1]!.timeMs : Infinity;
    const cs: FeedItem[] = filtered.map((c) => ({ kind: "comment", at: c.timeMs, c }));
    const hs: FeedItem[] = handovers
      .filter((h) => h.at >= oldest)
      .map((h) => ({ kind: "handover", at: h.at, title: h.title, presenter: h.presenter }));
    return [...cs, ...hs].sort((a, b) => b.at - a.at);
  }, [filtered, handovers]);

  return (
    <>
      <UnionJackBackdrop />
      <Header
        stats={stats}
        connected={connected}
        arrivals={arrivals}
        peak={peakPerMinute}
        now={now}
        trends={wireTrends}
        filter={filter}
        onToggleFilter={toggleFilter}
        mood={mood}
        emoji={emoji}
        onAir={onAir}
        host={host}
        nextUp={nextUp}
        hostActive={host ? filter === host.pattern || (filter !== null && host.re.test(filter)) : false}
        hostVerdict={hostStats?.mood ?? null}
      />
      <main className="shell">
        {comments.length > 0 && (
          <section className={`room-panel${showRoom ? "" : " room-panel--closed"}`}>
            <div className="room-panel__bar">
              <h2 className="room-panel__title">
                The Taproom
                <span>Tonight's arguments, mapped · argued together = tethered</span>
              </h2>
              <button
                type="button"
                className="room-panel__toggle"
                aria-expanded={showRoom}
                title={showRoom ? "Hide taproom debate map" : "Show taproom debate map"}
                onClick={() => setShowRoom((v) => !v)}
              >
                {showRoom ? "Hide taproom" : "Show taproom"}
              </button>
            </div>
            <AnimatePresence>
              {showRoom && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                >
                  <Constellation graph={graph} filter={filter} onToggle={toggleFilter} />
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        )}
        {comments.length === 0 ? (
          /* --boot delays its own appearance: a snapshot usually lands within
             ~300ms, and an empty state that flashes first reads as a glitch. */
          <div className="waiting waiting--boot">
            <div className="waiting__bars" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <p>Holding the front page…</p>
          </div>
        ) : (
          <>
            {filter ? (
              <p className="feed__meta feed__meta--filter">
                <span>
                  Filtering <b>“{filter}”</b> · {filtered.length} {filtered.length === 1 ? "dispatch" : "dispatches"}
                  {onAir ? ` · during ${onAir.title}` : ""}
                </span>
                <button
                  type="button"
                  className="feed__clear"
                  title="Clear active filter"
                  aria-label={`Clear active filter “${filter}”`}
                  onClick={() => setFilter(null)}
                >
                  Clear ✕
                </button>
              </p>
            ) : (
              replyShare > 0 && (
                <p className="feed__meta">
                  {comments.length} dispatches · {replyShare}% rebuttals
                  {hostStats && hostStats.share > 0 ? ` · ${hostStats.share}% to the host` : ""}
                </p>
              )
            )}
            {filtered.length === 0 ? (
              <div className="waiting">
                <p>
                  No dispatches mention “{filter}” in the recent debate. It may crop up as the room gets going.
                </p>
                <button
                  type="button"
                  className="feed__clear"
                  title="Clear the filter and return to every dispatch"
                  onClick={() => setFilter(null)}
                >
                  Back to all dispatches
                </button>
              </div>
            ) : (
              <ul className="feed">
                {feedItems.map((item) =>
                  item.kind === "handover" ? (
                    <li key={`h-${item.at}`} className="handover">
                      <i aria-hidden="true" />
                      <span>
                        {new Date(item.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · now
                        on air: {item.title}
                        {item.presenter ? ` with ${item.presenter}` : ""}
                      </span>
                      <i aria-hidden="true" />
                    </li>
                  ) : (
                    <Comment
                      key={item.c.uuid}
                      c={item.c}
                      terms={highlightTerms}
                      termsKey={termsKey}
                      filterLower={filterLower}
                      onTerm={toggleFilter}
                      hostRe={host?.re ?? null}
                      exHostRe={exHostActive?.re ?? null}
                    />
                  ),
                )}
              </ul>
            )}
          </>
        )}
      </main>
    </>
  );
}

// Reuse the root across HMR module re-evaluations so dev doesn't warn about
// calling createRoot twice on the same container.
const container = document.getElementById("root")!;
const store = window as unknown as { __feedRoot?: ReturnType<typeof createRoot> };
const root = store.__feedRoot ?? (store.__feedRoot = createRoot(container));
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
