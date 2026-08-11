import type { ContainerRef, VfComment } from "./viafoura";

const EVENT_FEED = "wss://realtimeeventfeeds.viafoura.co/eventfeed";

/** Viafoura pushes root comments and replies under these two message types. */
const COMMENT_MESSAGE_TYPES = ["livecomment_post", "reply_to_livecomment_post"];

/**
 * A comment is announced twice: `created` while it awaits moderation, then
 * `visible` once it clears. Subscribing to both and emitting on
 * `payload.state === "visible"` catches either path.
 */
const COMMENT_ACTIONS = ["created", "visible"];

const KEEP_ALIVE_MS = 30_000;

interface EventFrame {
  type: "event" | "subscribe" | string;
  subscription_id?: string;
  status?: string;
  event?: {
    message_type?: string;
    action?: string;
    container_uuid?: string;
    payload?: VfComment;
  };
}

export type RealtimeEvent =
  | { type: "comment"; comment: VfComment }
  | { type: "open" }
  | { type: "closed"; code: number; reason: string; retryInMs: number };

/** Queue that lets callback-driven sources feed an async generator. */
export class AsyncQueue<T> {
  #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T) {
    if (this.#closed) return;
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.#items.length > 0) {
        yield this.#items.shift()!;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.#waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

/**
 * Subscribes to the same realtime feed the GB News page uses and yields each
 * new comment, body included — no follow-up REST call needed.
 *
 * The three filter rules are AND-ed by the server. Without the `message_type`
 * and `action` rules the same subscription delivers ~1.2 MB/s of unrelated
 * notification traffic; with them it delivers only the comments.
 */
export async function* subscribeComments(
  { sectionUuid, containerUuid }: ContainerRef,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<RealtimeEvent> {
  const { signal } = options;
  const queue = new AsyncQueue<RealtimeEvent>();
  let failures = 0;
  let socket: WebSocket | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const stop = () => {
    stopped = true;
    clearInterval(keepAlive);
    socket?.close();
    queue.close();
  };
  signal?.addEventListener("abort", stop, { once: true });

  function connect() {
    if (stopped) return;
    const subscriptionId = crypto.randomUUID();
    const ws = new WebSocket(`${EVENT_FEED}?site_uuid=${sectionUuid}`);
    socket = ws;

    ws.addEventListener("open", () => {
      failures = 0;
      ws.send(
        JSON.stringify({
          type: "subscribe",
          subscription_id: subscriptionId,
          filter: {
            rules: [
              { type: "one_of", key: "container_uuid", values: [containerUuid] },
              { type: "one_of", key: "message_type", values: COMMENT_MESSAGE_TYPES },
              { type: "one_of", key: "action", values: COMMENT_ACTIONS },
            ],
          },
        }),
      );
      keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "keep-alive" }));
      }, KEEP_ALIVE_MS);
      queue.push({ type: "open" });
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let frame: EventFrame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      const comment = frame.event?.payload;
      if (frame.type !== "event" || !comment || comment.state !== "visible") return;
      queue.push({ type: "comment", comment });
    });

    const reconnect = (code: number, reason: string) => {
      clearInterval(keepAlive);
      if (stopped) return;
      const retryInMs = Math.min(30_000, 1_000 * 2 ** failures++);
      queue.push({ type: "closed", code, reason, retryInMs });
      setTimeout(connect, retryInMs);
    };

    ws.addEventListener("close", (event) => reconnect(event.code, event.reason || ""));
    ws.addEventListener("error", () => ws.close());
  }

  connect();

  try {
    yield* queue;
  } finally {
    stop();
  }
}
