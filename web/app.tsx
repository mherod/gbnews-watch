import {
  memo,
  StrictMode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";

import type { ServerMessage, Stats, WireComment } from "../src/wire";
import { computeTrends, termRegex, type Trend } from "../src/trending";

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

function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words[0]![0]! + (words[1]?.[0] ?? "")).toUpperCase();
}

function hue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

function avatarStyle(name: string) {
  const h = hue(name);
  return { background: `linear-gradient(140deg, hsl(${h} 62% 52%), hsl(${(h + 40) % 360} 58% 42%))` };
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

/** Shared 1s clock so relative times stay fresh without per-comment timers. */
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Recomputes trending words every few seconds, off the render/time path. */
function useTrends(comments: WireComment[]) {
  const [trends, setTrends] = useState<Trend[]>([]);
  const latest = useRef(comments);
  latest.current = comments;
  useEffect(() => {
    const compute = () => setTrends(computeTrends(latest.current, Date.now()));
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

/** Comment body clamped to a few lines, expandable when it overflows. */
function CommentBody({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return; // only measurable while clamped
    setOverflows(el.scrollHeight - el.clientHeight > 4);
  }, [text, expanded]);

  const clamped = !expanded;
  const className =
    "comment__body" +
    (clamped ? " comment__body--clamped" : "") +
    (clamped && overflows ? " comment__body--faded" : "");

  return (
    <>
      <p ref={ref} className={className}>
        {text}
      </p>
      {overflows && (
        <button type="button" className="comment__more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

const Comment = memo(function Comment({ c }: { c: CommentView }) {
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
    ? ({ "--rail": `hsl(${hue(c.author)} 55% 50%)` } as CSSProperties)
    : undefined;

  return (
    <li id={`c-${c.uuid}`} className={`comment${isReply ? " comment--reply" : ""}`} style={liStyle}>
      <div className="avatar" style={style} aria-hidden="true">
        {initials(c.author)}
      </div>
      <div className="comment__main">
        <div className="comment__head">
          <span className="comment__author">{c.author}</span>
          {c.chatty && (
            <span
              className="chatty"
              title={`${c.chatty.count} messages in the last ${c.chatty.windowMin} min`}
            >
              🗣 {c.chatty.count} in {c.chatty.windowMin}m
            </span>
          )}
          {c.isTopComment && <span className="tag tag--top">★ Top</span>}
          {c.isPinned && <span className="tag tag--pin">Pinned</span>}
          {c.isEdited && <span className="comment__edited">edited</span>}
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
          >
            <span className="replyto__arrow">↳</span>
            <span className="replyto__name">{c.replyingTo}</span>
            {c.parentQuote && <span className="replyto__quote">{c.parentQuote}</span>}
          </button>
        )}

        <CommentBody text={c.body.trim()} />

        <div className="comment__foot">
          {c.likes > 0 && <span className="stat stat--like">♥ {c.likes}</span>}
          {c.dislikes > 0 && <span className="stat">✕ {c.dislikes}</span>}
          {!isReply && c.replies > 0 && (
            <span className="stat stat--replies">
              {c.replies} {c.replies === 1 ? "reply" : "replies"}
            </span>
          )}
        </div>
      </div>
    </li>
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

function TrendBar({ trends, filter, onToggle }: {
  trends: Trend[];
  filter: string | null;
  onToggle: (word: string) => void;
}) {
  if (trends.length === 0) return null;
  return (
    <div className="trends" aria-label="Trending words">
      <span className="trends__label">🔥 Trending</span>
      <div className="trends__chips">
        {trends.map((t) => {
          const active = filter?.toLowerCase() === t.word.toLowerCase();
          return (
            <button
              key={t.word}
              type="button"
              className={`trends__chip${active ? " trends__chip--active" : ""}`}
              aria-pressed={active}
              title={active ? `Clear filter` : `Filter to “${t.word}”`}
              onClick={() => onToggle(t.word)}
            >
              {t.word}
              <i>{t.recent}</i>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Header({ stats, connected, arrivals, peak, now, trends, filter, onToggleFilter }: {
  stats: Stats;
  connected: boolean;
  arrivals: number[];
  peak: number;
  now: number;
  trends: Trend[];
  filter: string | null;
  onToggleFilter: (word: string) => void;
}) {
  const statusClass = connected && stats.upstream === "live"
    ? "status status--live"
    : connected
      ? "status"
      : "status status--down";
  const statusText = !connected ? "Disconnected" : stats.upstream === "live" ? "Live" : "Connecting";

  return (
    <header className="masthead">
      <div className="masthead__row">
        <div className="masthead__title">
          <h1>Have Your Say</h1>
          <p>
            Live from{" "}
            <a href="https://www.gbnews.com/watch/live" target="_blank" rel="noreferrer">
              gbnews.com/watch/live
            </a>
          </p>
        </div>
        <div className="meters">
          <span className={statusClass}>
            <span className="status__dot" />
            {statusText}
          </span>
          {stats.clients > 0 && <StatTile value={stats.clients} label="watching" className="meter--accent" />}
          <div className="meter meter--rate">
            <div className="meter__rateline">
              <b>{stats.perMinute}</b>
              <Sparkline arrivals={arrivals} now={now} />
            </div>
            <span>per min{peak > 0 ? ` · peak ${peak}` : ""}</span>
          </div>
          <StatTile value={stats.total} label="session" />
        </div>
      </div>
      <TrendBar trends={trends} filter={filter} onToggle={onToggleFilter} />
    </header>
  );
}

// ---------------------------------------------------------------- app

function App() {
  const { comments, stats, connected, arrivals, peakPerMinute } = useCommentFeed();
  const now = useNow(1000);
  const trends = useTrends(comments);
  const [filter, setFilter] = useState<string | null>(null);
  const toggleFilter = (word: string) =>
    setFilter((cur) => (cur && cur.toLowerCase() === word.toLowerCase() ? null : word));

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
    const re = termRegex(filter);
    return views.filter(
      (v) => re.test(v.body) || re.test(v.author) || (v.replyingTo ? re.test(v.replyingTo) : false),
    );
  }, [views, filter]);

  const replyShare = comments.length
    ? Math.round((comments.filter((c) => c.kind === "reply").length / comments.length) * 100)
    : 0;

  return (
    <>
      <Header
        stats={stats}
        connected={connected}
        arrivals={arrivals}
        peak={peakPerMinute}
        now={now}
        trends={trends}
        filter={filter}
        onToggleFilter={toggleFilter}
      />
      <main className="shell">
        {comments.length === 0 ? (
          <div className="waiting">
            <div className="waiting__bars" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <p>Waiting for the next comment…</p>
          </div>
        ) : (
          <>
            {filter ? (
              <p className="feed__meta feed__meta--filter">
                <span>
                  Filtering <b>“{filter}”</b> · {filtered.length} {filtered.length === 1 ? "match" : "matches"}
                </span>
                <button type="button" className="feed__clear" onClick={() => setFilter(null)}>
                  Clear ✕
                </button>
              </p>
            ) : (
              replyShare > 0 && (
                <p className="feed__meta">
                  {comments.length} recent · {replyShare}% replies
                </p>
              )
            )}
            {filtered.length === 0 ? (
              <div className="waiting">
                <p>
                  No comments mention “{filter}” in the last few minutes. It may scroll past as new ones arrive.
                </p>
              </div>
            ) : (
              <ul className="feed">
                {filtered.map((c) => (
                  <Comment key={c.uuid} c={c} />
                ))}
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
