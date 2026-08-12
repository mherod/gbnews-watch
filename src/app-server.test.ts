import { expect, test } from "bun:test";
import { startCommentServer } from "./app-server";
import type { Programme } from "./schedule";
import type { StreamEvent, StreamedComment } from "./stream";
import type { ServerMessage } from "./wire";

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

test("the server learns one shared topic graph and serves it at /api/room", async () => {
  const source = controllableSource();
  const server = startCommentServer({
    source,
    html: new Response("ok"),
    port: 0,
    roomTickMs: 20,
    roomCorpus: async () => ({ stems: [], phrases: [] }), // offline in tests
  });

  try {
    // Distinct authors, one topic — enough for a real (non-filler) trend.
    for (let i = 0; i < 4; i++) {
      source.emit({
        type: "comment",
        comment: comment({ body: "Burnham is at it again", authorUuid: `a${i}`, author: `Author ${i}` }),
      });
    }
    await Bun.sleep(80); // a few learning ticks

    const room = await (await fetch(`http://localhost:${server.port}/api/room`)).json();
    const ids = Object.keys(room.nodes);
    expect(ids).toContain("burnham"); // the shared memory learned the topic
    expect(room.nodes["burnham"].weight).toBeGreaterThan(3.9); // 4 mentions minus ms of decay
    expect(room.seen).toBeUndefined(); // internal dedupe list is not exposed

    // Two "visitors" read the same shared graph. Weights drift by fractions of
    // a permille between reads because decay is continuous — closeness, not
    // equality, is what "shared" means for a living value.
    const again = await (await fetch(`http://localhost:${server.port}/api/room`)).json();
    expect(again.nodes["burnham"].weight).toBeCloseTo(room.nodes["burnham"].weight, 2);
  } finally {
    source.end();
    await server.stop();
  }
});

test("/api/schedule serves the grid, computing what's on air per request", async () => {
  const source = controllableSource();
  // A programme boundary 400ms out, so a second request can prove onAir is
  // computed per request rather than snapshotted into the 30-minute cache.
  const handover = Date.now() + 400;
  const onNow: Programme = {
    date: "2026-08-12",
    start: new Date(Date.now() - 60_000),
    end: new Date(handover),
    title: "Currently Airing",
    type: "Live",
    image: null,
    presenters: ["Anne Example"],
    description: "d",
    showSectionId: 1,
    presenterSectionIds: [1],
  };
  const later: Programme = { ...onNow, start: new Date(handover), end: new Date(handover + 120_000), title: "Up Next" };
  const server = startCommentServer({
    source,
    html: new Response("ok"),
    port: 0,
    schedule: async () => [onNow, later], // offline in tests
  });

  try {
    const body = await (await fetch(`http://localhost:${server.port}/api/schedule`)).json();

    expect(body.programmes.map((p: { title: string }) => p.title)).toEqual(["Currently Airing", "Up Next"]);
    expect(body.onAir.title).toBe("Currently Airing");
    expect(body.onAir.start).toBe(onNow.start.toISOString()); // wire dates are ISO strings

    // Same injected grid, only time has moved — across the boundary the
    // route must answer differently.
    await Bun.sleep(700);
    const after = await (await fetch(`http://localhost:${server.port}/api/schedule`)).json();
    expect(after.onAir.title).toBe("Up Next");
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
