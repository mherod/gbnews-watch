/**
 * Where the shared topic memory sleeps between server lifetimes.
 *
 * The memory learns in process memory (fast, no I/O on the hot path) and this
 * seam only carries snapshots: load once at boot, save after each learning
 * tick. Which backend applies is an environment decision, not a code one:
 *
 * - `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel's Upstash integration) →
 *   Upstash over REST, via plain fetch. Preferred on serverless: stateless
 *   requests, so nothing goes stale when the function freezes between
 *   invocations, and no SDK dependency.
 * - `REDIS_URL` or `KV_URL` → Redis over TCP via Bun's built-in client
 *   (handles `rediss://` TLS). For self-hosted Redis or when REST isn't
 *   available.
 * - dev / self-hosted → a JSON file beside the repo, so `bun --hot` restarts
 *   and laptop reboots don't forget the evening's graph.
 * - none of the above → no store: the memory is warm-lifetime only.
 *
 * A snapshot is `serializeMemory` output verbatim — including `seen`, which is
 * what stops a restart double-counting the comment backfill it replays.
 */

export interface RoomStore {
  /** A human word for logs ("upstash", "redis", "file:…"). */
  name: string;
  load(): Promise<string | null>;
  /**
   * `expireAtMs` asks the backend to drop the key at that wall-clock time
   * (Redis EXAT). Best-effort: the file backend ignores it, so a consumer
   * whose snapshots go stale must also check relevance on load.
   */
  save(snapshot: string, opts?: { expireAtMs?: number }): Promise<void>;
}

const KEY = "gbnews-watch:room:v1";

/**
 * Upstash REST store. GET {base}/get/{key} answers {"result": string|null};
 * POST {base}/set/{key} with the raw body as the value answers {"result":"OK"}.
 */
export function upstashRestRoomStore(baseUrl: string, token: string, key = KEY): RoomStore {
  const headers = { Authorization: `Bearer ${token}` };
  const url = (op: string) => `${baseUrl.replace(/\/$/, "")}/${op}/${encodeURIComponent(key)}`;
  return {
    name: "upstash",
    async load() {
      const res = await fetch(url("get"), { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`upstash get responded ${res.status}`);
      const body = (await res.json()) as { result?: string | null; error?: string };
      if (body.error) throw new Error(`upstash get: ${body.error}`);
      return body.result ?? null;
    },
    async save(snapshot: string, opts?: { expireAtMs?: number }) {
      // SET options ride as query params in Upstash's REST dialect; EXAT wants
      // unix seconds, rounded up so a key never dies before its stated moment.
      const exat = opts?.expireAtMs !== undefined ? `?exat=${Math.ceil(opts.expireAtMs / 1000)}` : "";
      const res = await fetch(url("set") + exat, {
        method: "POST",
        headers,
        body: snapshot,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`upstash set responded ${res.status}`);
      const body = (await res.json()) as { error?: string };
      if (body.error) throw new Error(`upstash set: ${body.error}`);
    },
  };
}

/** Redis-over-TCP store using Bun's built-in client (supports rediss:// TLS). */
export function redisRoomStore(url: string, key = KEY): RoomStore {
  let client: import("bun").RedisClient | undefined;
  const connect = async () => {
    if (!client) {
      const { RedisClient } = await import("bun");
      client = new RedisClient(url);
    }
    return client;
  };
  return {
    name: "redis",
    async load() {
      return (await connect()).get(key);
    },
    async save(snapshot: string, opts?: { expireAtMs?: number }) {
      const redis = await connect();
      if (opts?.expireAtMs !== undefined) {
        await redis.send("SET", [key, snapshot, "EXAT", String(Math.ceil(opts.expireAtMs / 1000))]);
      } else {
        await redis.set(key, snapshot);
      }
    },
  };
}

/** File-backed store for dev and self-hosted runs. */
export function fileRoomStore(path: string): RoomStore {
  return {
    name: `file:${path}`,
    async load() {
      const file = Bun.file(path);
      return (await file.exists()) ? file.text() : null;
    },
    async save(snapshot: string) {
      await Bun.write(path, snapshot);
    },
  };
}

/**
 * Picks the backend for this environment. Upstash REST wins when the Vercel
 * integration has provisioned it; a TCP URL comes next; a file only makes
 * sense where the filesystem outlives the process (dev), because a serverless
 * /tmp write has exactly the lifetime problem this exists to fix.
 *
 * Generic over the snapshot being stored: the room memory and the schedule
 * cache are different keys in the same backend, so anything else that needs
 * to survive a cold start picks its own key/file and calls this.
 */
export function resolveSnapshotStore(dev: boolean, key: string, filePath: string): RoomStore | null {
  const { KV_REST_API_URL, KV_REST_API_TOKEN, REDIS_URL, KV_URL } = process.env;
  if (KV_REST_API_URL && KV_REST_API_TOKEN) return upstashRestRoomStore(KV_REST_API_URL, KV_REST_API_TOKEN, key);
  const tcpUrl = REDIS_URL ?? KV_URL;
  if (tcpUrl) return redisRoomStore(tcpUrl, key);
  if (dev) return fileRoomStore(filePath);
  return null;
}

export function resolveRoomStore(dev: boolean): RoomStore | null {
  const file = process.env.ROOM_MEMORY_FILE;
  return resolveSnapshotStore(dev || Boolean(file), KEY, file ?? ".room-memory.json");
}
