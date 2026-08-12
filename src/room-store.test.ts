import { expect, test } from "bun:test";
import { fileRoomStore, resolveRoomStore } from "./room-store";

test("file store round-trips a snapshot and reports absence as null", async () => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/room-store-test-${crypto.randomUUID()}.json`;
  const store = fileRoomStore(path);

  expect(await store.load()).toBeNull(); // nothing there yet
  await store.save('{"nodes":{},"edges":{},"seen":[],"decayedAt":1}');
  expect(await store.load()).toBe('{"nodes":{},"edges":{},"seen":[],"decayedAt":1}');

  await Bun.file(path).delete();
});

test("resolution: dev gets a file store, bare prod gets none", () => {
  const hadRedis = process.env.REDIS_URL;
  const hadFile = process.env.ROOM_MEMORY_FILE;
  delete process.env.REDIS_URL;
  delete process.env.ROOM_MEMORY_FILE;
  try {
    expect(resolveRoomStore(true)?.name).toBe("file:.room-memory.json");
    expect(resolveRoomStore(false)).toBeNull();
    process.env.REDIS_URL = "redis://example";
    expect(resolveRoomStore(false)?.name).toBe("redis");
  } finally {
    if (hadRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = hadRedis;
    if (hadFile !== undefined) process.env.ROOM_MEMORY_FILE = hadFile;
  }
});
