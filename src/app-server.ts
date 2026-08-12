import { buildCorpus, corpusToJson, parseRssTitles, type CorpusJson } from "./corpus";
import type { StreamEvent, StreamedComment } from "./stream";
import type { ServerMessage, Stats, WireComment } from "./wire";

const TOPIC = "comments";

/**
 * News-cycle vocabulary from the site's own RSS feed, used by the client to
 * weight topic detection — never rendered. Cached because headlines change on
 * the order of minutes, not seconds, and the feed shouldn't be hit per visitor.
 * On failure the previous corpus is served for as long as it exists; the
 * detector works unaided otherwise, so an empty corpus is a safe fallback.
 */
const CORPUS_FEED_URL = "https://www.gbnews.com/feeds/news.rss";
const CORPUS_TTL_MS = 10 * 60_000;
let corpusCache: { at: number; data: CorpusJson } | null = null;
let corpusInFlight: Promise<CorpusJson> | null = null;

async function fetchCorpus(): Promise<CorpusJson> {
  if (corpusCache && Date.now() - corpusCache.at < CORPUS_TTL_MS) return corpusCache.data;
  // Single flight so a burst of tabs doesn't fan out into parallel feed hits.
  corpusInFlight ??= (async () => {
    try {
      const res = await fetch(CORPUS_FEED_URL, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`feed responded ${res.status}`);
      const data = corpusToJson(buildCorpus(parseRssTitles(await res.text())));
      corpusCache = { at: Date.now(), data };
      return data;
    } catch (error) {
      console.warn("corpus fetch failed:", error);
      return corpusCache?.data ?? { stems: [], phrases: [] };
    } finally {
      corpusInFlight = null;
    }
  })();
  return corpusInFlight;
}

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

// index.html carries the hashed asset references, so it must revalidate every
// load or a redeploy leaves repeat visitors pointing at a stale bundle. The
// hashed assets themselves never change under a given name, so cache them hard.
const HTML_CACHE = "no-cache";
const ASSET_CACHE = "public, max-age=31536000, immutable";

function assetResponse(asset: Asset, path: string): Response {
  const cache = path === "/" || path === "/index.html" ? HTML_CACHE : ASSET_CACHE;
  return new Response(Buffer.from(asset.base64, "base64"), {
    headers: { "Content-Type": asset.type, "Cache-Control": cache },
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
      return asset ? assetResponse(asset, "/index.html") : new Response("Frontend not built", { status: 503 });
    });

  const server = Bun.serve({
    port,
    routes: {
      "/": indexRoute,
      "/api/health": () =>
        Response.json({ ok: true, container: containerUuid, buffered: recent.length, comments: recent, ...stats() }),
      "/api/corpus": async () =>
        Response.json(await fetchCorpus(), {
          headers: { "Cache-Control": "public, max-age=300" },
        }),
    },
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === "/ws") {
        return server.upgrade(request)
          ? undefined
          : new Response("Expected a websocket", { status: 426 });
      }
      if (assets && request.method === "GET") {
        const key = pathname === "/" ? "/index.html" : pathname;
        const asset = assets[key];
        if (asset) return assetResponse(asset, key);
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
