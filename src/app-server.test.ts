import { describe, expect, test } from "bun:test";
import { createScheduleSupplier, startCommentServer } from "./app-server";
import type { RoomStore } from "./room-store";
import { serializeSchedule, type Programme } from "./schedule";
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
  const onAirNow: Programme = {
    date: "2026-08-12",
    start: new Date(Date.now() - 60_000),
    end: new Date(Date.now() + 3_600_000),
    title: "The Live Show",
    type: "Live",
    image: null,
    presenters: [],
    description: "",
    showSectionId: null,
    presenterSectionIds: [],
  };
  const server = startCommentServer({
    source,
    html: new Response("ok"),
    port: 0,
    roomTickMs: 20,
    roomCorpus: async () => ({ stems: [], phrases: [] }), // offline in tests
    schedule: async () => [onAirNow], // offline, and pins what's on air
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
    // Learning happened while "The Live Show" was on air — the topic knows it.
    expect(room.nodes["burnham"].onAir["The Live Show"]).toBeGreaterThan(3.9);

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

describe("createScheduleSupplier", () => {
  const programme = (startOffsetMs: number, endOffsetMs: number, title = "Slot"): Programme => ({
    date: "2026-08-12",
    start: new Date(Date.now() + startOffsetMs),
    end: new Date(Date.now() + endOffsetMs),
    title,
    type: "Live",
    image: null,
    presenters: [],
    description: "",
    showSectionId: null,
    presenterSectionIds: [],
  });

  /** An in-memory RoomStore that records what the supplier does to it. */
  function stubStore(initial: string | null) {
    const activity = { loads: 0, saves: [] as { snapshot: string; expireAtMs?: number }[] };
    const store: RoomStore = {
      name: "stub",
      load: async () => {
        activity.loads++;
        return initial;
      },
      save: async (snapshot, opts) => {
        activity.saves.push({ snapshot, expireAtMs: opts?.expireAtMs });
      },
    };
    return { store, activity };
  }

  test("a cold start adopts a fresh stored snapshot without touching the origin", async () => {
    const stored = [programme(-60_000, 3_600_000, "Restored")];
    const { store, activity } = stubStore(serializeSchedule({ fetchedAt: Date.now() - 1_000, programmes: stored }));
    let scrapes = 0;
    const supplier = createScheduleSupplier({
      store,
      fetchGrid: async () => {
        scrapes++;
        return [programme(-60_000, 3_600_000, "Scraped")];
      },
    });

    const grid = await supplier();
    expect(grid.map((p) => p.title)).toEqual(["Restored"]);
    expect(scrapes).toBe(0);
    expect(activity.loads).toBe(1);
    // Still within the memory TTL — the store is not re-read either.
    await supplier();
    expect(activity.loads).toBe(1);
  });

  test("a stale-but-relevant snapshot triggers a refresh and covers its failure", async () => {
    const stored = [programme(-60_000, 3_600_000, "Stale but relevant")];
    const { store } = stubStore(serializeSchedule({ fetchedAt: Date.now() - 60_000, programmes: stored }));
    let scrapes = 0;
    const supplier = createScheduleSupplier({
      store,
      ttlMs: 10_000, // the stored snapshot is 60s old — beyond freshness
      fetchGrid: async () => {
        scrapes++;
        throw new Error("origin down");
      },
    });

    const grid = await supplier();
    expect(scrapes).toBe(1); // it did try to refresh
    expect(grid.map((p) => p.title)).toEqual(["Stale but relevant"]); // and fell back
  });

  test("a successful scrape is saved with expiry at the grid's horizon", async () => {
    const scraped = [programme(-60_000, 3_600_000, "First"), programme(3_600_000, 7_200_000, "Last")];
    const { store, activity } = stubStore(null);
    const supplier = createScheduleSupplier({ store, fetchGrid: async () => scraped });

    await supplier();
    expect(activity.saves).toHaveLength(1);
    expect(activity.saves[0]!.expireAtMs).toBe(scraped[1]!.end.getTime());
    expect(activity.saves[0]!.snapshot).toContain("Last");
  });

  test("an expired snapshot is ignored and an empty scrape is not persisted", async () => {
    const ended = [programme(-7_200_000, -3_600_000, "Over")];
    const { store, activity } = stubStore(serializeSchedule({ fetchedAt: Date.now() - 1_000, programmes: ended }));
    const supplier = createScheduleSupplier({ store, fetchGrid: async () => [] });

    const grid = await supplier();
    expect(grid).toEqual([]); // the ended grid never surfaces
    expect(activity.saves).toHaveLength(0); // nothing worth persisting
  });

  test("a successful-but-empty scrape never evicts a relevant grid", async () => {
    const stored = [programme(-60_000, 3_600_000, "Still relevant")];
    const { store } = stubStore(serializeSchedule({ fetchedAt: Date.now() - 60_000, programmes: stored }));
    let scrapes = 0;
    const supplier = createScheduleSupplier({
      store,
      ttlMs: 10_000, // adopted snapshot is already stale, so a refresh runs
      fetchGrid: async () => {
        scrapes++;
        return []; // HTTP 200 wearing an empty body
      },
    });

    expect((await supplier()).map((p) => p.title)).toEqual(["Still relevant"]);
    // The kept grid also kept its old timestamp, so the next call retries
    // rather than trusting the empty result for a full TTL.
    expect((await supplier()).map((p) => p.title)).toEqual(["Still relevant"]);
    expect(scrapes).toBe(2);
  });

  test("a transient store error at boot does not disarm the restore path", async () => {
    const stored = [programme(-60_000, 3_600_000, "Recovered")];
    const snapshot = serializeSchedule({ fetchedAt: Date.now() - 1_000, programmes: stored });
    let loads = 0;
    const store: RoomStore = {
      name: "flaky",
      load: async () => {
        loads++;
        if (loads === 1) throw new Error("timeout");
        return snapshot;
      },
      save: async () => {},
    };
    const supplier = createScheduleSupplier({
      store,
      fetchGrid: async () => {
        throw new Error("origin down");
      },
    });

    expect(await supplier()).toEqual([]); // both layers down — the safe fallback
    expect((await supplier()).map((p) => p.title)).toEqual(["Recovered"]); // store retried, grid restored
    expect(loads).toBe(2);
  });

  test("a broken store degrades to memory-only, both ways", async () => {
    const scraped = [programme(-60_000, 3_600_000, "Scraped anyway")];
    const store: RoomStore = {
      name: "broken",
      load: async () => {
        throw new Error("store down");
      },
      save: async () => {
        throw new Error("store down");
      },
    };
    const supplier = createScheduleSupplier({ store, fetchGrid: async () => scraped });

    const grid = await supplier();
    expect(grid.map((p) => p.title)).toEqual(["Scraped anyway"]);
  });
});

test("the learned graph survives a server restart and doesn't double-count the replayed backfill", async () => {
  // One store shared across two server lifetimes, standing in for Redis.
  let stored: string | null = null;
  const store = {
    name: "stub",
    load: async () => stored,
    save: async (snapshot: string) => {
      stored = snapshot;
    },
  };
  const offline = async () => ({ stems: [], phrases: [] });
  const burnhamComments = Array.from({ length: 4 }, (_, i) =>
    comment({ uuid: `fixed-${i}`, body: "Burnham is at it again", authorUuid: `a${i}`, author: `Author ${i}` }),
  );

  // First lifetime: learn, snapshot, die.
  const sourceA = controllableSource();
  const serverA = startCommentServer({
    source: sourceA, html: new Response("ok"), port: 0,
    roomTickMs: 20, roomCorpus: offline, roomStore: store, schedule: async () => [],
  });
  try {
    for (const c2 of burnhamComments) sourceA.emit({ type: "comment", comment: c2 });
    await Bun.sleep(80);
  } finally {
    sourceA.end();
    await serverA.stop();
  }
  expect(stored).not.toBeNull(); // a snapshot was written

  // Second lifetime: restore before learning, then replay the same backfill —
  // exactly what happens after a cold start.
  const sourceB = controllableSource();
  const serverB = startCommentServer({
    source: sourceB, html: new Response("ok"), port: 0,
    roomTickMs: 20, roomCorpus: offline, roomStore: store, schedule: async () => [],
  });
  try {
    await Bun.sleep(30); // hydration settles
    const restored = await (await fetch(`http://localhost:${serverB.port}/api/room`)).json();
    expect(Object.keys(restored.nodes)).toContain("burnham"); // knowledge survived death

    for (const c2 of burnhamComments) sourceB.emit({ type: "comment", comment: c2 });
    await Bun.sleep(80); // learning ticks over the replayed buffer

    const after = await (await fetch(`http://localhost:${serverB.port}/api/room`)).json();
    // The snapshot's seen-list recognises the replayed uuids: still ~4, not 8.
    expect(after.nodes["burnham"].weight).toBeLessThan(4.5);
    expect(after.nodes["burnham"].weight).toBeGreaterThan(3.5);
  } finally {
    sourceB.end();
    await serverB.stop();
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
