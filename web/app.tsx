import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type { ServerMessage, Stats, WireComment } from "../src/wire.ts";

const FEED_LIMIT = 150;

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

function relativeTime(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function useCommentFeed() {
  const [comments, setComments] = useState<WireComment[]>([]);
  const [stats, setStats] = useState<Stats>({
    total: 0,
    perMinute: 0,
    upstream: "connecting",
    clients: 0,
  });
  const [connected, setConnected] = useState(false);
  const retries = useRef(0);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${location.host}/ws`);

      socket.onopen = () => {
        retries.current = 0;
        setConnected(true);
      };

      socket.onmessage = (event) => {
        const message: ServerMessage = JSON.parse(event.data);
        setStats(message.stats);
        if (message.type === "snapshot") setComments(message.comments.slice(0, FEED_LIMIT));
        if (message.type === "comment") {
          setComments((current) => [message.comment, ...current].slice(0, FEED_LIMIT));
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = setTimeout(connect, Math.min(8000, 500 * 2 ** retries.current++));
      };

      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      if (!socket) return;
      // Don't let our own teardown schedule a reconnect, and don't abort a
      // handshake mid-flight — StrictMode's double-mount does exactly that.
      socket.onclose = null;
      const target = socket;
      if (target.readyState === WebSocket.CONNECTING) {
        target.addEventListener("open", () => target.close(), { once: true });
      } else if (target.readyState === WebSocket.OPEN) {
        target.close();
      }
    };
  }, []);

  return { comments, stats, connected };
}

function Comment({ comment, now }: { comment: WireComment; now: number }) {
  const tint = useMemo(() => hue(comment.author), [comment.author]);
  return (
    <li className="comment">
      <div
        className="avatar"
        style={{ background: `linear-gradient(140deg, hsl(${tint} 62% 52%), hsl(${(tint + 40) % 360} 58% 42%))` }}
        aria-hidden="true"
      >
        {initials(comment.author)}
      </div>
      <div>
        <div className="comment__head">
          <span className="comment__author">{comment.author}</span>
          {comment.replyingTo && <span className="comment__reply">↳ {comment.replyingTo}</span>}
          <time className="comment__time" dateTime={comment.postedAt}>
            {relativeTime(comment.postedAt, now)}
          </time>
        </div>
        <p className="comment__body">{comment.body.trim()}</p>
        {(comment.likes > 0 || comment.isTopComment) && (
          <div className="comment__foot">
            {comment.likes > 0 && <span>♥ {comment.likes}</span>}
            {comment.isTopComment && <span className="tag">Top comment</span>}
          </div>
        )}
      </div>
    </li>
  );
}

function App() {
  const { comments, stats, connected } = useCommentFeed();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const live = connected && stats.upstream === "live";
  const statusClass = live ? "status status--live" : connected ? "status" : "status status--down";
  const statusText = !connected ? "Disconnected" : stats.upstream === "live" ? "Live" : "Connecting";

  return (
    <>
      <header className="masthead">
        <div className="masthead__row">
          <div>
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
            <div className="meter">
              <b>{stats.perMinute}</b>
              <span>per min</span>
            </div>
            <div className="meter">
              <b>{stats.total}</b>
              <span>session</span>
            </div>
          </div>
        </div>
      </header>

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
          <ul className="feed">
            {comments.map((comment) => (
              <Comment key={comment.uuid} comment={comment} now={now} />
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
