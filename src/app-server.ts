import type { StreamEvent, StreamedComment } from "./stream";
import type { ServerMessage, Stats, WireComment } from "./wire";

const TOPIC = "comments";

export interface CommentServerOptions {
  /** Anything that yields stream events — the live feed, or a stub in tests. */
  source: AsyncIterable<StreamEvent>;
  /** The bundled HTML entry point served at `/` (a `.html` import, or a Response in tests). */
  html: Bun.HTMLBundle | Response;
  port?: number;
  /** How many comments a freshly-opened tab is handed. */
  snapshotSize?: number;
  containerUuid?: string;
  /** Hot reload and console forwarding. Off in production. */
  dev?: boolean;
  /**
   * Directory of built frontend assets to serve as a fallback. On Vercel the
   * CDN answers these paths before the function is invoked; this exists for
   * local production-parity runs and non-Vercel hosts.
   */
  publicDir?: string;
}

/**
 * Bun drops a websocket that has been idle in both directions, and this client
 * never sends anything — so a quiet spell would kill every connection. The
 * heartbeat doubles as a stats refresh, which the rate meter needs anyway:
 * without it "per min" freezes at whatever it read when the last comment landed.
 */
const HEARTBEAT_MS = 30_000;
const IDLE_TIMEOUT_SECONDS = 120;

export interface CommentServer {
  url: URL;
  port: number;
  fetch(request: Request): Response | Promise<Response>;
  /** Resolves when the source is exhausted. */
  finished: Promise<void>;
  stop(): Promise<void>;
}


function toWire(comment: StreamedComment): WireComment {
  return { ...comment, postedAt: comment.postedAt.toISOString() };
}

/**
 * Serves the UI and fans one comment stream out to every connected tab.
 *
 * The source is injected rather than created here so a test can drive the
 * websocket without waiting on live GB News traffic.
 */
export function startCommentServer(options: CommentServerOptions): CommentServer {
  const {
    source,
    html,
    port = 3000,
    snapshotSize = 40,
    containerUuid,
    dev = false,
    publicDir,
  } = options;

  const recent: WireComment[] = [];
  /**
   * When each comment was *posted*, not when we saw it — the startup backfill
   * arrives at once but spans the preceding minutes, and stamping it with the
   * current time made the rate meter read 40/min beside "10m ago" timestamps.
   */
  const postedAt: number[] = [];
  let upstream: Stats["upstream"] = "connecting";
  let total = 0;

  function perMinute() {
    const cutoff = Date.now() - 60_000;
    while (postedAt.length > 0 && postedAt[0]! < cutoff) postedAt.shift();
    return postedAt.length;
  }

  function stats(): Stats {
    return { total, perMinute: perMinute(), upstream, clients: server.subscriberCount(TOPIC) };
  }

  function publish(message: ServerMessage) {
    server.publish(TOPIC, JSON.stringify(message));
  }

  const server = Bun.serve({
    port,
    routes: {
      "/": html,
      "/api/health": () =>
        Response.json({ ok: true, container: containerUuid, buffered: recent.length, comments: recent, ...stats() }),

    },
    async fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === "/ws") {
        return server.upgrade(request)
          ? undefined
          : new Response("Expected a websocket", { status: 426 });
      }
      // Static fallback for hosts without a CDN layer in front of the server.
      if (publicDir && request.method === "GET" && !pathname.includes("..")) {
        const asset = Bun.file(`${publicDir}${pathname === "/" ? "/index.html" : pathname}`);
        if (await asset.exists()) return new Response(asset);
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      idleTimeout: IDLE_TIMEOUT_SECONDS,
      open(ws) {
        ws.subscribe(TOPIC);
        const snapshot: ServerMessage = { type: "snapshot", comments: recent, stats: stats() };
        ws.send(JSON.stringify(snapshot));
      },
      close(ws) {
        ws.unsubscribe(TOPIC);
      },
      message() {
        // The client never sends anything; this stream is one-way.
      },
    },
    development: dev ? { hmr: true, console: true } : false,
  });

  const heartbeat = setInterval(() => {
    if (server.subscriberCount(TOPIC) > 0) publish({ type: "status", stats: stats() });
  }, HEARTBEAT_MS);

  const finished = pump();

  async function pump() {
    for await (const event of source) {
      switch (event.type) {
        case "comment": {
          total++;
          postedAt.push(event.comment.postedAt.getTime());
          recent.unshift(toWire(event.comment));
          recent.length = Math.min(recent.length, snapshotSize);
          publish({ type: "comment", comment: recent[0]!, stats: stats() });
          break;
        }
        case "primed": {
          upstream = "live";
          publish({ type: "status", stats: stats() });
          break;
        }
        case "notice": {
          upstream = "reconnecting";
          console.warn(event.text);
          publish({ type: "status", text: event.text, stats: stats() });
          // The stream reconnects itself; the next comment proves it came back.
          setTimeout(() => {
            if (upstream === "reconnecting") upstream = "live";
          }, 5_000).unref?.();
          break;
        }
        case "error": {
          console.error("upstream poll failed:", event.error);
          break;
        }
      }
    }
  }

  return {
    url: server.url,
    port: server.port!,
    fetch: (request: Request) => server.fetch(request),
    finished,
    stop: async () => {
      clearInterval(heartbeat);
      await server.stop(true);
    },
  };

}
