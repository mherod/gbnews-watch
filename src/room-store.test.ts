import { expect, test } from "bun:test";
import { fileRoomStore, resolveRoomStore, upstashRestRoomStore } from "./room-store";

test("file store round-trips a snapshot and reports absence as null", async () => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/room-store-test-${crypto.randomUUID()}.json`;
  const store = fileRoomStore(path);

  expect(await store.load()).toBeNull(); // nothing there yet
  await store.save('{"nodes":{},"edges":{},"seen":[],"decayedAt":1}');
  expect(await store.load()).toBe('{"nodes":{},"edges":{},"seen":[],"decayedAt":1}');

  await Bun.file(path).delete();
});

test("upstash REST store speaks the get/set protocol", async () => {
  // A miniature Upstash: GET /get/:key answers {result}, POST /set/:key stores
  // the raw body. Auth is checked so a missing token can't silently pass.
  const values = new Map<string, string>();
  const mock = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer test-token") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const [, op, key] = new URL(req.url).pathname.split("/");
      if (op === "get") return Response.json({ result: values.get(key!) ?? null });
      if (op === "set") {
        values.set(key!, await req.text());
        return Response.json({ result: "OK" });
      }
      return Response.json({ error: "unknown op" }, { status: 400 });
    },
  });

  try {
    const store = upstashRestRoomStore(`http://localhost:${mock.port}`, "test-token");
    expect(await store.load()).toBeNull(); // empty store answers null
    await store.save('{"nodes":{"labour":{}},"edges":{},"seen":["a"],"decayedAt":5}');
    expect(await store.load()).toBe('{"nodes":{"labour":{}},"edges":{},"seen":["a"],"decayedAt":5}');

    const badAuth = upstashRestRoomStore(`http://localhost:${mock.port}`, "wrong");
    expect(badAuth.load()).rejects.toThrow(); // auth failures are loud, not null
  } finally {
    await mock.stop(true);
  }
});

test("resolution: Upstash REST wins, then TCP, then the dev file, then none", () => {
  const saved = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    KV_URL: process.env.KV_URL,
    REDIS_URL: process.env.REDIS_URL,
    ROOM_MEMORY_FILE: process.env.ROOM_MEMORY_FILE,
  };
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    expect(resolveRoomStore(true)?.name).toBe("file:.room-memory.json");
    expect(resolveRoomStore(false)).toBeNull();

    process.env.KV_URL = "rediss://example";
    expect(resolveRoomStore(false)?.name).toBe("redis"); // Vercel TCP URL works alone

    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "token";
    expect(resolveRoomStore(false)?.name).toBe("upstash"); // REST outranks TCP
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
