import { describe, expect, test } from "bun:test";
import {
  deserializeSchedule,
  extractScheduleArray,
  normalizeProgramme,
  onAirAt,
  parseSchedulePage,
  programmesOn,
  programmeToWire,
  scheduleHorizon,
  serializeSchedule,
} from "./schedule";

/**
 * Mirrors the live page byte-for-byte in the parts that matter: the array sits
 * mid-document after a data-date div, uses Python-repr quoting (single quotes,
 * switching to double quotes when the value contains an apostrophe), and is
 * followed by more script the extractor must not consume.
 */
function page(records: string): string {
  return (
    '<html><body><div class="sched" data-date="2026-08-12"></div><script> \n' +
    "      \n" +
    `      window.schedule_response=[${records}]; \n` +
    "       schedule_response.sort((a, b) => (a.StartDateTime > b.StartDateTime) ? 1 : -1)\n" +
    ' \n       window.show_urls={ "583176211" : "/shows/dewbs-co" };\n' +
    "</script></body></html>"
  );
}

const LIVE_SHOW =
  "{'ProgramDate': '2026-08-12', 'StartDateTime': '2026-08-12T06:00:00+01:00', 'EndDateTime': '2026-08-12T09:30:00+01:00', " +
  "'ShowTitle': 'Breakfast', 'ShowType': 'Live', " +
  "'ShowImage': 'https://www.gbnews.com/media-library/image.jpg?id=1&&width=600&quality=80', " +
  "'Presenters': ['Anne Example', 'Bob Example'], 'Description': 'The morning programme.', " +
  "'ShowSectionId': 2283960377, 'PresentersSectionIds': [2262790667, 587477194, 587477194]}";

const ANTHEM =
  "{'ProgramDate': '2026-08-12', 'StartDateTime': '2026-08-12T05:59:00+01:00', 'EndDateTime': '2026-08-12T05:59:00+01:00', " +
  "'ShowTitle': 'UK National Anthem', 'ShowType': 'Live', 'ShowImage': 'https://assets.rbl.ms/32415081/origin.jpg', " +
  "'Presenters': [], \"Description\": \"'God Save the King' is broadcast each morning.\", " +
  "'ShowSectionId': null, 'PresentersSectionIds': []}";

const REPLAY =
  "{'ProgramDate': '2026-08-13', 'StartDateTime': '2026-08-13T03:00:00+01:00', 'EndDateTime': '2026-08-13T04:59:00+01:00', " +
  "'ShowTitle': 'Late Replay', 'ShowType': 'Replay', 'ShowImage': 'https://www.gbnews.com/media-library/image.jpg?id=2&width=600', " +
  "'Presenters': ['Cat Example'], 'Description': 'A replay.', 'ShowSectionId': 2240099801, 'PresentersSectionIds': [583176073]}";

describe("extractScheduleArray", () => {
  test("finds the array mid-document and stops at its end", () => {
    const arr = extractScheduleArray(page(`${LIVE_SHOW}, ${ANTHEM}`));
    expect(arr).toHaveLength(2);
    expect((arr[0] as Record<string, unknown>).ShowTitle).toBe("Breakfast");
  });

  test("reads double-quoted strings holding apostrophes", () => {
    const [rec] = extractScheduleArray(page(ANTHEM)) as Record<string, unknown>[];
    expect(rec!.Description).toBe("'God Save the King' is broadcast each morning.");
  });

  test("reads escaped quotes, unicode escapes, and Python literals", () => {
    const arr = extractScheduleArray(
      "window.schedule_response=[{'A': 'it\\'s', 'B': \"a \\\"b\\\"\", 'C': '\\u00e9\\n', 'D': None, 'E': True, 'F': False}]",
    ) as Record<string, unknown>[];
    expect(arr[0]).toEqual({ A: "it's", B: 'a "b"', C: "é\n", D: null, E: true, F: false });
  });

  test("reads numbers, nested arrays, bare keys, and trailing commas", () => {
    const arr = extractScheduleArray(
      "window.schedule_response = [{Ids: [1, -2, 3.5, 1e3,], 'Empty': [], 'Obj': {}},]",
    ) as Record<string, unknown>[];
    expect(arr[0]).toEqual({ Ids: [1, -2, 3.5, 1000], Empty: [], Obj: {} });
  });

  test("throws when the assignment is missing", () => {
    expect(() => extractScheduleArray("<html>no schedule here</html>")).toThrow(/not found/);
  });

  test("throws on malformed escapes rather than decoding garbage", () => {
    expect(() => extractScheduleArray("window.schedule_response=[{'A': '\\uZZZZ'}]")).toThrow(/\\uXXXX/);
    expect(() => extractScheduleArray("window.schedule_response=[{'A': '\\u{1F600}'}]")).toThrow(/\\uXXXX/);
    expect(() => extractScheduleArray("window.schedule_response=[{'A': '\\xZZ'}]")).toThrow(/\\xXX/);
  });

  test("throws on a truncated array rather than returning part of one", () => {
    expect(() => extractScheduleArray(`window.schedule_response=[${LIVE_SHOW}, {'ProgramDate': '2026`)).toThrow();
  });
});

describe("normalizeProgramme", () => {
  const raw = (overrides: Record<string, unknown>) => ({
    ProgramDate: "2026-08-12",
    StartDateTime: "2026-08-12T06:00:00+01:00",
    EndDateTime: "2026-08-12T07:00:00+01:00",
    ShowTitle: "Show",
    ShowType: "Live",
    ShowImage: "https://example.test/i.jpg",
    Presenters: ["A"],
    Description: "d",
    ShowSectionId: 1,
    PresentersSectionIds: [1],
    ...overrides,
  });

  test("parses BST offsets into the correct instant despite the page's GMT label", () => {
    const p = normalizeProgramme(raw({}))!;
    expect(p.start.toISOString()).toBe("2026-08-12T05:00:00.000Z");
  });

  test("dedupes repeated presenter section ids", () => {
    const p = normalizeProgramme(raw({ PresentersSectionIds: [2262790667, 587477194, 587477194] }))!;
    expect(p.presenterSectionIds).toEqual([2262790667, 587477194]);
  });

  test("repairs doubled query separators in image URLs", () => {
    const p = normalizeProgramme(raw({ ShowImage: "https://x.test/i.jpg?id=1&&width=600&&&quality=80" }))!;
    expect(p.image).toBe("https://x.test/i.jpg?id=1&width=600&quality=80");
  });

  test("keeps null section ids null and empty presenter lists empty", () => {
    const p = normalizeProgramme(raw({ ShowSectionId: null, Presenters: [], PresentersSectionIds: [] }))!;
    expect(p.showSectionId).toBeNull();
    expect(p.presenters).toEqual([]);
    expect(p.presenterSectionIds).toEqual([]);
  });

  test("coerces the feed's historical string shapes: comma-joined names, numeric-string ids", () => {
    const p = normalizeProgramme(
      raw({ Presenters: "Anne Example, Bob Example", ShowSectionId: "42", PresentersSectionIds: ["7", "7", 8] }),
    )!;
    expect(p.presenters).toEqual(["Anne Example", "Bob Example"]);
    expect(p.showSectionId).toBe(42);
    expect(p.presenterSectionIds).toEqual([7, 8]);
  });

  test("falls back to the local date of StartDateTime when ProgramDate is missing", () => {
    const p = normalizeProgramme(raw({ ProgramDate: null }))!;
    expect(p.date).toBe("2026-08-12");
  });

  test("drops records that cannot be placed in time", () => {
    expect(normalizeProgramme(raw({ StartDateTime: "not a date" }))).toBeNull();
    expect(normalizeProgramme(raw({ ShowTitle: "" }))).toBeNull();
    expect(normalizeProgramme("not an object")).toBeNull();
  });
});

describe("parseSchedulePage", () => {
  test("returns programmes sorted by start even when the source is unordered", () => {
    const programmes = parseSchedulePage(page(`${REPLAY}, ${LIVE_SHOW}, ${ANTHEM}`));
    expect(programmes.map((p) => p.title)).toEqual(["UK National Anthem", "Breakfast", "Late Replay"]);
  });

  test("keeps zero-duration continuity slots in the listing", () => {
    const programmes = parseSchedulePage(page(ANTHEM));
    expect(programmes).toHaveLength(1);
    expect(programmes[0]!.start.getTime()).toBe(programmes[0]!.end.getTime());
  });
});

describe("lookups", () => {
  const programmes = parseSchedulePage(page(`${ANTHEM}, ${LIVE_SHOW}, ${REPLAY}`));

  test("onAirAt is start-inclusive, end-exclusive", () => {
    expect(onAirAt(programmes, new Date("2026-08-12T05:00:00Z"))?.title).toBe("Breakfast");
    expect(onAirAt(programmes, new Date("2026-08-12T08:29:59Z"))?.title).toBe("Breakfast");
    expect(onAirAt(programmes, new Date("2026-08-12T08:30:00Z"))).toBeUndefined();
  });

  test("onAirAt never returns a zero-duration slot", () => {
    expect(onAirAt(programmes, new Date("2026-08-12T04:59:00Z"))).toBeUndefined();
  });

  test("onAirAt does not require its input to be start-sorted", () => {
    const reversed = [...programmes].reverse();
    expect(onAirAt(reversed, new Date("2026-08-12T05:00:00Z"))?.title).toBe("Breakfast");
  });

  test("overlaps resolve to the latest-starting slot, in any input order", () => {
    const overlap = normalizeProgramme({
      ProgramDate: "2026-08-12",
      StartDateTime: "2026-08-12T06:30:00+01:00",
      EndDateTime: "2026-08-12T07:00:00+01:00",
      ShowTitle: "Special Bulletin",
    })!;
    const at = new Date("2026-08-12T05:45:00Z");
    expect(onAirAt([...programmes, overlap], at)?.title).toBe("Special Bulletin");
    expect(onAirAt([overlap, ...programmes], at)?.title).toBe("Special Bulletin");
  });

  test("programmesOn groups by the picker date", () => {
    expect(programmesOn(programmes, "2026-08-12").map((p) => p.title)).toEqual(["UK National Anthem", "Breakfast"]);
    expect(programmesOn(programmes, "2026-08-13").map((p) => p.title)).toEqual(["Late Replay"]);
    expect(programmesOn(programmes, "2026-08-14")).toEqual([]);
  });
});

describe("programmeToWire", () => {
  test("serialises dates as UTC ISO strings", () => {
    const [p] = parseSchedulePage(page(LIVE_SHOW));
    const wire = programmeToWire(p!);
    expect(wire.start).toBe("2026-08-12T05:00:00.000Z");
    expect(wire.end).toBe("2026-08-12T08:30:00.000Z");
    expect(wire.title).toBe("Breakfast");
  });
});

describe("schedule snapshots", () => {
  const programmes = parseSchedulePage(page(`${ANTHEM}, ${LIVE_SHOW}, ${REPLAY}`));
  const fetchedAt = new Date("2026-08-12T04:00:00Z").getTime();
  // REPLAY is the latest slot: ends 2026-08-13T03:59:00Z.
  const horizon = new Date("2026-08-13T03:59:00Z").getTime();
  const duringGrid = new Date("2026-08-12T06:00:00Z").getTime();

  test("scheduleHorizon is the end of the last programme", () => {
    expect(scheduleHorizon(programmes)).toBe(horizon);
    expect(scheduleHorizon([])).toBeNull();
  });

  test("round-trips through serialize/deserialize with dates and order intact", () => {
    const raw = serializeSchedule({ fetchedAt, programmes });
    const revived = deserializeSchedule(raw, duringGrid)!;
    expect(revived.fetchedAt).toBe(fetchedAt);
    expect(revived.programmes.map((p) => p.title)).toEqual(programmes.map((p) => p.title));
    expect(revived.programmes[1]!.start.getTime()).toBe(programmes[1]!.start.getTime());
    expect(revived.programmes[1]!.presenterSectionIds).toEqual(programmes[1]!.presenterSectionIds);
    expect(revived.programmes[0]!.showSectionId).toBeNull();
  });

  test("a snapshot whose final programme has ended is no longer relevant", () => {
    const raw = serializeSchedule({ fetchedAt, programmes });
    expect(deserializeSchedule(raw, horizon)).toBeNull(); // end-exclusive: gone at the horizon
    expect(deserializeSchedule(raw, horizon - 1)).not.toBeNull();
  });

  test("rejects garbage, wrong shapes, and empty grids", () => {
    expect(deserializeSchedule("not json", duringGrid)).toBeNull();
    expect(deserializeSchedule("42", duringGrid)).toBeNull();
    expect(deserializeSchedule('{"fetchedAt":"soon","programmes":[]}', duringGrid)).toBeNull();
    expect(deserializeSchedule(serializeSchedule({ fetchedAt, programmes: [] }), duringGrid)).toBeNull();
  });

  test("drops unrevivable records but keeps the rest", () => {
    const raw = JSON.stringify({
      fetchedAt,
      programmes: [
        { title: "No dates" },
        ...JSON.parse(serializeSchedule({ fetchedAt, programmes })).programmes,
      ],
    });
    const revived = deserializeSchedule(raw, duringGrid)!;
    expect(revived.programmes).toHaveLength(programmes.length);
  });
});
