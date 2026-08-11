import { expect, test } from "bun:test";
import { startCommentServer } from "./app-server.ts";
import type { StreamEvent, StreamedComment } from "./stream.ts";
import type { ServerMessage } from "./wire.ts";

function comment(overrides: Partial<StreamedComment> = {}): StreamedComment {
  return {
    kind: "comment",
    uuid: crypto.randomUUID(),
    threadUuid: "thread",
    author: "Test Author",
    authorUuid: "actor",
    body: "Hello from the stub stream",
    postedAt: new Date(),
    likes: 0,
    dislikes: 0,
    replies: 0,
    isPinned: false,
    isPicked: false,
    isTopComment: false,
    isEdited: false,
    via: "socket",
    ...overrides,
  };
}

/** Lets a test push stream events at the server one at a time. */
function controllableSource() {
  const pending: StreamEvent[] = [];
  let notify: (() => void) | undefined;
  let done = false;

  return {
    emit(event: StreamEvent) {
      pending.push(event);
      notify?.();
    },
    end() {
      done = true;
      notify?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      while (true) {
        while (pending.length > 0) yield pending.shift()!;
        if (done) return;
        await new Promise<void>((resolve) => (notify = resolve));
      }
    },
  };
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
      once: true,
    });
  });
}

test("a connecting tab gets a snapshot, then each new comment", async () => {
  const source = controllableSource();
  const backfilled = comment({ body: "Posted before the tab opened" });
  const server = startCommentServer({ source, html: new Response("ok"), port: 0 });

  try {
    source.emit({ type: "comment", comment: backfilled });
    source.emit({ type: "primed", tracking: 1 });
    await Bun.sleep(20);

    const socket = new WebSocket(`ws://localhost:${server.port}/ws`);
    const snapshot = await nextMessage(socket);

    expect(snapshot.type).toBe("snapshot");
    if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.comments).toHaveLength(1);
    expect(snapshot.comments[0]!.body).toBe("Posted before the tab opened");
    expect(snapshot.comments[0]!.postedAt).toBe(backfilled.postedAt.toISOString());
    expect(snapshot.stats.upstream).toBe("live");
    expect(snapshot.stats.total).toBe(1);

    const arriving = nextMessage(socket);
    source.emit({ type: "comment", comment: comment({ body: "Posted while watching" }) });
    const pushed = await arriving;

    expect(pushed.type).toBe("comment");
    if (pushed.type !== "comment") throw new Error("expected a comment");
    expect(pushed.comment.body).toBe("Posted while watching");
    expect(pushed.stats.total).toBe(2);

    socket.close();
  } finally {
    source.end();
    await server.stop();
  }
});

test("the rate meter counts when comments were posted, not when they arrived", async () => {
  const source = controllableSource();
  const server = startCommentServer({ source, html: new Response("ok"), port: 0 });

  try {
    // A backfill batch: all delivered now, but posted across the last ten minutes.
    source.emit({ type: "comment", comment: comment({ postedAt: new Date(Date.now() - 600_000) }) });
    source.emit({ type: "comment", comment: comment({ postedAt: new Date(Date.now() - 300_000) }) });
    source.emit({ type: "comment", comment: comment({ postedAt: new Date(Date.now() - 5_000) }) });
    await Bun.sleep(20);

    const health = await (await fetch(`http://localhost:${server.port}/api/health`)).json();

    expect(health.total).toBe(3);
    expect(health.perMinute).toBe(1);
  } finally {
    source.end();
    await server.stop();
  }
});
