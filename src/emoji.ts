/**
 * Extracts and ranks the emoji flying around the chat. Grapheme segmentation
 * keeps compound emoji whole — flags (🇬🇧), skin tones, and ZWJ sequences count
 * as one, not as their code points.
 */

export interface EmojiCount {
  emoji: string;
  count: number;
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** True when a string contains emoji — used to route the feed filter to an
 *  emoji (substring) match rather than a whole-word regex. */
export function isEmoji(s: string): boolean {
  return PICTOGRAPHIC.test(s);
}

export function topEmoji(
  comments: readonly { body: string; postedAt: string }[],
  now: number,
  opts: { windowMs?: number; limit?: number } = {},
): EmojiCount[] {
  const windowMs = opts.windowMs ?? 300_000;
  const limit = opts.limit ?? 5;

  const counts = new Map<string, number>();
  for (const c of comments) {
    if (now - new Date(c.postedAt).getTime() > windowMs) continue;
    for (const { segment } of segmenter.segment(c.body)) {
      if (PICTOGRAPHIC.test(segment)) counts.set(segment, (counts.get(segment) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2) // ignore one-offs
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([emoji, count]) => ({ emoji, count }));
}
