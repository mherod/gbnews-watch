/**
 * Where the shared topic memory sleeps between server lifetimes.
 *
 * The memory learns in process memory (fast, no I/O on the hot path) and this
 * seam only carries snapshots: load once at boot, save after each learning
 * tick. Which backend applies is an environment decision, not a code one:
 *
 * - `REDIS_URL` set → Redis via Bun's built-in client. This is the durable
 *   path on Vercel (e.g. an Upstash integration), where instance memory and
 *   the filesystem both vanish on cold start.
 * - dev / self-hosted → a JSON file beside the repo, so `bun --hot` restarts
 *   and laptop reboots don't forget the evening's graph.
 * - neither → no store: the memory is warm-lifetime only, as before.
 *
 * A snapshot is `serializeMemory` output verbatim — including `seen`, which is
 * what stops a restart double-counting the comment backfill it replays.
 */

export interface RoomStore {
  /** A human word for logs ("redis", "file"). */
  name: string;
  load(): Promise<string | null>;
  save(snapshot: string): Promise<void>;
}

const REDIS_KEY = "gbnews-watch:room:v1";

/** Redis-backed store using Bun's built-in client (connects via REDIS_URL). */
export function redisRoomStore(): RoomStore {
  return {
    name: "redis",
    async load() {
      const { redis } = await import("bun");
      return redis.get(REDIS_KEY);
    },
    async save(snapshot: string) {
      const { redis } = await import("bun");
      await redis.set(REDIS_KEY, snapshot);
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
 * Picks the backend for this environment. Redis wins when configured; a file
 * only makes sense where the filesystem outlives the process (dev), because a
 * serverless /tmp write has exactly the lifetime problem this exists to fix.
 */
export function resolveRoomStore(dev: boolean): RoomStore | null {
  if (process.env.REDIS_URL) return redisRoomStore();
  if (dev || process.env.ROOM_MEMORY_FILE) {
    return fileRoomStore(process.env.ROOM_MEMORY_FILE ?? ".room-memory.json");
  }
  return null;
}
