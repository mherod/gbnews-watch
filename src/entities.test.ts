import { expect, test } from "bun:test";
import { entityPattern, matchEntityAt, registerPresenterEntities, startsUppercase } from "./entities";

/** Scan a body the way computeTrends does and list the entities detected. */
function detect(body: string): string[] {
  const tokens = [...body.matchAll(/[\p{L}][\p{L}\p{N}'']*/gu)].map((m) => m[0]);
  const found: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const hit = matchEntityAt(tokens, i);
    if (hit) {
      found.push(hit.canonical);
      i += hit.length;
    } else {
      i += 1;
    }
  }
  return found;
}

test("matches abbreviations case-insensitively, including 2-letter ones", () => {
  expect(detect("the NHS is on its knees")).toContain("NHS");
  expect(detect("leave the eu for good")).toContain("EU"); // lowercase, 2 letters
  expect(detect("BBC bias again")).toContain("BBC");
  expect(detect("scrap ULEZ now")).toContain("ULEZ");
});

test("upgrades aliases to their canonical label", () => {
  expect(detect("typical Tory sleaze")).toEqual(["Conservative"]);
  expect(detect("the Tories again")).toEqual(["Conservative"]);
  expect(detect("Vote Reform")).toEqual(["Reform UK"]);
  expect(detect("reform uk surging")).toEqual(["Reform UK"]); // two-word, any case
  expect(detect("the Lib Dems flip flop")).toEqual(["Liberal Democrats"]);
  expect(detect("Greens want more tax")).toEqual(["Green Party"]);
});

test("requireCaps aliases ignore the common lowercase word", () => {
  expect(detect("reform is needed in the NHS")).toEqual(["NHS"]); // verb, not the party
  expect(detect("turkey dinner was lovely")).toEqual([]); // the bird
  expect(detect("back to labour in the fields")).toEqual([]); // work, not the party
  expect(detect("i love green vegetables")).toEqual([]); // colour/veg
  expect(detect("my home office is freezing")).toEqual([]); // WFH room
});

test("never maps pronouns or question words to entities", () => {
  expect(detect("this affects us all")).toEqual([]); // us !-> USA
  expect(detect("who is coming to fix it")).toEqual([]); // who !-> WHO
  expect(detect("the monarchy costs us a fortune")).toEqual(["Monarchy"]); // us stays out
});

test("my precision overrides: un / vat / Dover need caps", () => {
  expect(detect("the UN is useless")).toContain("UN");
  expect(detect("a wrong un if ever")).toEqual([]); // lowercase un ignored
  expect(detect("VAT is daylight robbery")).toContain("VAT");
  expect(detect("a vat of oil")).toEqual([]); // the container ignored
  expect(detect("boats landing at Dover")).toContain("Dover");
  expect(detect("a lovely dover sole")).toEqual([]); // the fish ignored
});

test("prefers the longer two-word alias", () => {
  expect(detect("stop the boats in the English Channel")).toEqual(["English Channel"]);
  expect(detect("the Home Office is hopeless")).toEqual(["Home Office"]);
  expect(detect("Northern Ireland politics")).toEqual(["Northern Ireland"]); // not Ireland
  expect(detect("net zero is killing industry")).toEqual(["Net Zero"]);
});

test("startsUppercase distinguishes SHOUT and shout", () => {
  expect(startsUppercase("NHS")).toBe(true);
  expect(startsUppercase("Reform")).toBe(true);
  expect(startsUppercase("reform")).toBe(false);
});

test("entityPattern is an alias-aware alternation for highlight/filter", () => {
  const p = entityPattern("Conservative");
  expect(p).toBeDefined();
  expect(p).toContain("tory");
  expect(p).toContain("conservative");
  // A regex built from it matches every form.
  const re = new RegExp(`\\b(?:${p})\\b`, "i");
  expect(re.test("blame the Tories")).toBe(true);
  expect(re.test("a Conservative government")).toBe(true);
});

test("GB News-isms merge nicknames into the presenter's proper name", () => {
  expect(detect("Chopper had the scoop")).toEqual(["Christopher Hope"]);
  expect(detect("a chopper flew over")).toEqual([]); // helicopter stays lowercase
  expect(detect("good old Nige")).toEqual(["Nigel Farage"]);
  expect(detect("Dewbs said it best")).toEqual(["Michelle Dewberry"]);
});

test("schedule presenters register dynamically with a caps surname alias", () => {
  registerPresenterEntities(["Camilla Tominey"]);
  expect(detect("Camilla Tominey was right")).toEqual(["Camilla Tominey"]);
  expect(detect("agree with Tominey there")).toEqual(["Camilla Tominey"]);
  expect(detect("tominey lowercase")).toEqual([]); // bare surname needs caps
});

test("ambiguous surnames only match through the full billed name", () => {
  registerPresenterEntities(["Dan Wootton-Hope", "Sam Frost"]);
  // "Frost" is a common word — the bare surname must not register.
  expect(detect("Sam Frost opened the show")).toEqual(["Sam Frost"]);
  expect(detect("Frost on the windscreen this morning")).toEqual([]);
});

test("harvested politicians and room vocabulary merge their fragments", () => {
  expect(detect("Starmer waffling again")).toEqual(["Keir Starmer"]);
  expect(detect("vote for Kemi")).toEqual(["Kemi Badenoch"]);
  expect(detect("if Binface comes second")).toEqual(["Count Binface"]);
  expect(detect("the uni party mud slings")).toEqual(["Uniparty"]);
  expect(detect("typical uniparty stitch-up")).toEqual(["Uniparty"]);
});

test("registration is idempotent and never overwrites hand-curated entries", () => {
  const before = entityPattern("Tom Harwood");
  registerPresenterEntities(["Tom Harwood", "Tom Harwood"]);
  expect(entityPattern("Tom Harwood")).toBe(before!);
  expect(detect("Harwood nailed it")).toEqual(["Tom Harwood"]);
});
