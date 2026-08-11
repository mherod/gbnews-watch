import { AsyncQueue, subscribeComments } from "./realtime.ts";
import {
  listComments,
  listReplies,
  UserDirectory,
  type ContainerRef,
  type VfComment,
} from "./viafoura.ts";

export interface StreamedComment {
  kind: "comment" | "reply";
  uuid: string;
  threadUuid: string;
  author: string;
  authorUuid: string;
  /** Display name of the author being replied to, when this is a reply. */
  replyingTo?: string;
  body: string;
  postedAt: Date;
  likes: number;
  dislikes: number;
  replies: number;
  isPinned: boolean;
  isPicked: boolean;
  isTopComment: boolean;
  isEdited: boolean;
  /** Which source delivered it first. */
  via: "socket" | "poll";
  sourceUrl?: string;
}

export type StreamEvent =
  | { type: "comment"; comment: StreamedComment }
  | { type: "primed"; tracking: number }
  | { type: "notice"; text: string }
  | { type: "error"; error: unknown; retryInMs: number };

export type Transport = "socket" | "poll";

export interface StreamOptions extends ContainerRef {
  /** `socket` pushes in real time; `poll` only hits the REST API. */
  transport?: Transport;
  /** Milliseconds between polls (also the socket transport's safety net). */
  intervalMs?: number;
  /** Root comments fetched per poll. */
  pageLimit?: number;
  /** Replies fetched per thread that has changed. */
  replyLimit?: number;
  /** Follow replies as well as top-level comments. */
  includeReplies?: boolean;
  /** Emit this many existing comments before switching to live-only. */
  backfill?: number;
  /** How many comment UUIDs to remember for de-duplication. */
  memory?: number;
  signal?: AbortSignal;
}

/** Set that forgets its oldest entries once it outgrows `max`. */
export class RecentSet {
  #set = new Set<string>();
  #order: string[] = [];

  constructor(private readonly max: number) {}

  has(key: string) {
    return this.#set.has(key);
  }

  add(key: string) {
    if (this.#set.has(key)) return;
    this.#set.add(key);
    this.#order.push(key);
    if (this.#order.length > this.max) {
      const evicted = this.#order.splice(0, this.#order.length - this.max);
      for (const key of evicted) this.#set.delete(key);
    }
  }

  get size() {
    return this.#set.size;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

type Ingest =
  | { kind: "comments"; comments: VfComment[]; via: "socket" | "poll"; priming?: boolean }
  | { kind: "notice"; text: string }
  | { kind: "error"; error: unknown; retryInMs: number };

/**
 * Yields each comment once, oldest first.
 *
 * The socket transport receives whole comments pushed from Viafoura, with the
 * REST poll left running at a slower cadence as a safety net — anything the
 * socket misses during a reconnect still turns up, and de-duplication means a
 * comment seen twice is only emitted once.
 */
export async function* streamComments(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const {
    sectionUuid,
    containerUuid,
    transport = "socket",
    intervalMs = transport === "socket" ? 30_000 : 3_000,
    pageLimit = 50,
    replyLimit = 50,
    includeReplies = true,
    backfill = 0,
    memory = 5_000,
    signal: externalSignal,
  } = options;

  // Own controller so that a consumer who stops iterating also stops the sources.
  const control = new AbortController();
  const signal = control.signal;
  externalSignal?.addEventListener("abort", () => control.abort(), { once: true });
  if (externalSignal?.aborted) control.abort();

  const ref: ContainerRef = { sectionUuid, containerUuid };
  const users = new UserDirectory(sectionUuid);
  const seen = new RecentSet(memory);
  const queue = new AsyncQueue<Ingest>();

  const poller = pollLoop();
  const pusher = transport === "socket" ? socketLoop() : Promise.resolve();
  void Promise.all([poller, pusher]).then(() => queue.close());
  signal.addEventListener("abort", () => queue.close(), { once: true });

  let priming = true;

  try {
    for await (const ingest of queue) {
      if (ingest.kind === "notice") {
        yield { type: "notice", text: ingest.text };
        continue;
      }
      if (ingest.kind === "error") {
        yield { type: "error", error: ingest.error, retryInMs: ingest.retryInMs };
        continue;
      }

      const fresh = ingest.comments.filter(
        (comment) => comment.state === "visible" && !seen.has(comment.content_uuid),
      );
      for (const comment of fresh) seen.add(comment.content_uuid);
      fresh.sort((a, b) => a.time - b.time);

      const emitting = ingest.priming ? (backfill > 0 ? fresh.slice(-backfill) : []) : fresh;
      for (const comment of emitting) {
        yield { type: "comment", comment: await present(comment, ingest.via, users, signal) };
      }

      if (ingest.priming && priming) {
        priming = false;
        yield { type: "primed", tracking: seen.size };
      }
    }
  } finally {
    control.abort();
  }

  /** REST poll: the only source under `--transport poll`, a safety net otherwise. */
  async function pollLoop() {
    const replyCounts = new Map<string, number>();
    let first = true;
    let failures = 0;

    while (!signal?.aborted) {
      try {
        const page = await listComments(ref, { limit: pageLimit, signal });
        const roots = page.contents.filter((c) => c.state === "visible");
        const collected = [...roots];

        if (includeReplies) {
          const stale = roots.filter(
            (c) => c.total_replies > 0 && replyCounts.get(c.content_uuid) !== c.total_replies,
          );
          const pages = await mapLimit(stale, 4, (thread) =>
            listReplies(ref, thread.content_uuid, { limit: replyLimit, signal }).catch(() => null),
          );
          for (const [index, replyPage] of pages.entries()) {
            const thread = stale[index]!;
            if (!replyPage) continue;
            replyCounts.set(thread.content_uuid, thread.total_replies);
            collected.push(...replyPage.contents);
          }
        }

        queue.push({ kind: "comments", comments: collected, via: "poll", priming: first });
        first = false;
        failures = 0;
      } catch (error) {
        if (signal?.aborted) break;
        const retryInMs = Math.min(30_000, 2_000 * 2 ** failures++);
        queue.push({ kind: "error", error, retryInMs });
        await sleep(retryInMs, signal);
        continue;
      }

      await sleep(intervalMs, signal);
    }
  }

  /** Realtime feed: whole comments, pushed as they clear moderation. */
  async function socketLoop() {
    for await (const event of subscribeComments(ref, { signal })) {
      switch (event.type) {
        case "comment":
          queue.push({ kind: "comments", comments: [event.comment], via: "socket" });
          break;
        case "closed":
          queue.push({
            kind: "notice",
            text: `Realtime feed closed (${event.code}${event.reason ? ` ${event.reason}` : ""}) — reconnecting in ${event.retryInMs / 1000}s`,
          });
          break;
      }
    }
  }
}

async function present(
  comment: VfComment,
  via: "socket" | "poll",
  users: UserDirectory,
  signal?: AbortSignal,
): Promise<StreamedComment> {
  const isReply = comment.thread_uuid !== comment.content_container_uuid;
  const [author, replyingTo] = await Promise.all([
    users.displayName(comment.actor_uuid, signal),
    comment.parent_actor_uuid
      ? users.displayName(comment.parent_actor_uuid, signal)
      : Promise.resolve(undefined),
  ]);

  return {
    kind: isReply ? "reply" : "comment",
    uuid: comment.content_uuid,
    threadUuid: comment.thread_uuid,
    author,
    authorUuid: comment.actor_uuid,
    replyingTo,
    body: comment.content,
    postedAt: new Date(comment.time),
    likes: comment.total_likes,
    dislikes: comment.total_dislikes,
    replies: comment.total_replies,
    isPinned: comment.is_pinned,
    isPicked: comment.is_picked,
    isTopComment: comment.is_top_comment,
    isEdited: comment.is_edited,
    via,
    sourceUrl: comment.metadata?.origin_url,
  };
}
