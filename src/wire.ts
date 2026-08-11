import type { StreamedComment } from "./stream";

/** A comment as it arrives over the browser socket — `postedAt` is JSON, so a string. */
export type WireComment = Omit<StreamedComment, "postedAt"> & { postedAt: string };

export interface Stats {
  /** Comments seen since the server started. */
  total: number;
  perMinute: number;
  upstream: "connecting" | "live" | "reconnecting";
  clients: number;
}

export type ServerMessage =
  | { type: "snapshot"; comments: WireComment[]; stats: Stats }
  | { type: "comment"; comment: WireComment; stats: Stats }
  | { type: "status"; text?: string; stats: Stats };
