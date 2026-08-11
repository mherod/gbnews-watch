import type { StreamEvent, StreamedComment } from "./stream";
import type { ServerMessage, Stats, WireComment } from "./wire";

const TOPIC = "comments";

export interface CommentServerOptions {
  /** Anything that yields stream events — the live feed, or a stub in tests. */
  source: AsyncIterable<StreamEvent>;
  /**
   * The `/` route value: a Bun HTML bundle (dev — enables HMR) or a plain
   * Response (tests). Mutually exclusive with `assets`; exactly one is given.
   */
  html?: Bun.HTMLBundle | Response;
  /**
   * Built frontend inlined into the function (prod). Served from memory for `/`
   * and every asset path, because the Bun framework builder routes all requests
   * here and publishes nothing to the CDN.
   */
  assets?: FrontendAssets;
  port?: number;
  /** How many comments a freshly-opened tab is handed. */
  snapshotSize?: number;
  containerUuid?: string;
  /** Hot reload and console forwarding. Off in production. */
  dev?: boolean;
}

export interface Asset {
  type: string;
  base64: string;
}

/** Built frontend files keyed by request path (e.g. "/index.html"). */
export type FrontendAssets = Record<string, Asset>;

function assetResponse(asset: Asset): Response {
  return new Response(Buffer.from(asset.base64, "base64"), {
    headers: { "Content-Type": asset.type, "Cache-Control": "public, max-age=3600" },
  });
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
  const { source, html, assets, port = 3000, snapshotSize = 40, containerUuid, dev = false } = options;

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

  // In dev, `html` is a Bun bundle mounted at "/" so HMR works. In prod there is
  // no bundle — "/" serves index.html from the inlined assets map.
  const indexRoute =
    html ??
    (() => {
      const asset = assets?.["/index.html"];
      return asset ? assetResponse(asset) : new Response("Frontend not built", { status: 503 });
    });

  const server = Bun.serve({
    port,
    routes: {
      "/": indexRoute,
      "/api/health": () =>
        Response.json({ ok: true, container: containerUuid, buffered: recent.length, comments: recent, ...stats() }),
    },
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === "/ws") {
        return server.upgrade(request)
          ? undefined
          : new Response("Expected a websocket", { status: 426 });
      }
      if (assets && request.method === "GET") {
        const asset = assets[pathname === "/" ? "/index.html" : pathname];
        if (asset) return assetResponse(asset);
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
