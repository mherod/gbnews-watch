import { expect, test } from "bun:test";
import { parseContainerId } from "./viafoura";
import { RecentSet } from "./stream";

test("parseContainerId reads the vf:container_id meta tag", () => {
  const html = `<head><meta name="vf:container_id" content="2658636820"/></head>`;
  expect(parseContainerId(html)).toBe("2658636820");
});

test("parseContainerId returns null when the tag is absent", () => {
  expect(parseContainerId("<head><title>No comments here</title></head>")).toBeNull();
});

test("RecentSet remembers recent keys and evicts the oldest", () => {
  const seen = new RecentSet(3);
  for (const key of ["a", "b", "c"]) seen.add(key);
  expect(seen.has("a")).toBe(true);

  seen.add("d");
  expect(seen.size).toBe(3);
  expect(seen.has("a")).toBe(false);
  expect(seen.has("d")).toBe(true);
});

test("RecentSet ignores duplicates", () => {
  const seen = new RecentSet(2);
  seen.add("a");
  seen.add("a");
  seen.add("b");
  expect(seen.size).toBe(2);
  expect(seen.has("a")).toBe(true);
});
