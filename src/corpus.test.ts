import { expect, test } from "bun:test";
import { buildCorpus, corpusFromJson, corpusToJson, parseRssTitles } from "./corpus";

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
<title>GB News</title>
<image><title>GB News</title></image>
<item><title>Andy Burnham hits back at critics over migrant hotels</title><link>x</link></item>
<item><title><![CDATA[Keir Starmer &amp; Rachel Reeves clash on tax]]></title></item>
<item><title>Simple body measurement may beat BMI, scientists say</title></item>
<item><title></title></item>
</channel></rss>`;

test("parses item titles only, handling CDATA and entities", () => {
  const titles = parseRssTitles(FEED);
  expect(titles).toHaveLength(3); // channel/image titles and the empty one excluded
  expect(titles[0]).toBe("Andy Burnham hits back at critics over migrant hotels");
  expect(titles[1]).toBe("Keir Starmer & Rachel Reeves clash on tax");
});

test("extracts capitalised runs as phrases and content words as stems", () => {
  const corpus = buildCorpus(parseRssTitles(FEED));
  expect(corpus.phrases.has("andy burnham")).toBe(true);
  expect(corpus.phrases.has("keir starmer")).toBe(true);
  // Stem-joined exactly like trend keys, so "Reeves" folds to "reeve" — the
  // same folding a comment's bigram key gets, which is what makes them match.
  expect(corpus.phrases.has("rachel reeve")).toBe(true);
  expect(corpus.phrases.has("keir starmer rachel reeve")).toBe(false); // & broke the run
  expect(corpus.stems.has("migrant")).toBe(true); // stemmed like the detector
  expect(corpus.stems.has("hotel")).toBe(true);
});

test("a lone sentence-case first word is not treated as a name", () => {
  const corpus = buildCorpus(["Simple ideas beat clever ones"]);
  expect(corpus.phrases.size).toBe(0); // "Simple" alone proves nothing
  expect(corpus.stems.has("simple")).toBe(true); // but it still counts as vocabulary
});

test("a digit inside a name run survives into stems and phrases", () => {
  const corpus = buildCorpus(["Saturday 5 lineup revealed"]);
  expect(corpus.phrases.has("saturday 5")).toBe(true);
  expect(corpus.stems.has("5")).toBe(true); // per-word phrase boost needs it
});

test("a written-number headline lands on the same digit phrase key", () => {
  const corpus = buildCorpus(["Saturday Five returns tonight"]);
  expect(corpus.phrases.has("saturday 5")).toBe(true); // "Five" stems to "5" and survives the gate
});

test("a run of bare digits is a score, not a name", () => {
  const corpus = buildCorpus(["24 7 moaning continues"]);
  expect(corpus.phrases.size).toBe(0); // no capitalised word anchors the run
});

test("round-trips through JSON and shrugs off junk", () => {
  const corpus = buildCorpus(parseRssTitles(FEED));
  const back = corpusFromJson(corpusToJson(corpus));
  expect(back.phrases.has("andy burnham")).toBe(true);
  expect(corpusFromJson(null).stems.size).toBe(0);
  expect(corpusFromJson({ stems: "junk" as never, phrases: undefined as never }).phrases.size).toBe(0);
});
