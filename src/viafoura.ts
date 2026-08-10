/**
 * Minimal client for the Viafoura APIs that power GB News' "Have Your Say".
 *
 * Everything here is read-only and unauthenticated — the same calls the public
 * widget makes before you sign in.
 */

const COMMENTS_API = "https://livecomments.viafoura.co/v4/livecomments";
const IAM_API = "https://iam.viafoura.co/v3";

/** GB News' Viafoura section (site) UUID. */
export const GBNEWS_SECTION_UUID = "00000000-0000-4000-8000-d9187a288918";

/**
 * Container behind the "Have Your Say" thread on https://www.gbnews.com/watch/live.
 *
 * The page's `vf:container_id` meta tag points at a different, empty container,
 * so this one can't be derived from the markup — it was read off the widget's
 * own network calls.
 */
export const GBNEWS_LIVE_CONTAINER_UUID = "d4eb1580-3fa5-439d-8a54-66c0fc445290";

export type CommentState = "visible" | "hidden" | "banned" | (string & {});

export interface VfComment {
  section_uuid: string;
  content_container_uuid: string;
  /** Root comment of the thread, or the container UUID for a root comment. */
  thread_uuid: string;
  /** Container UUID when this is a root comment, otherwise the comment replied to. */
  parent_uuid: string;
  content_uuid: string;
  actor_uuid: string;
  /** Only present on replies. */
  parent_actor_uuid?: string;
  content: string;
  time: number;
  date_created: number;
  state: CommentState;
  total_likes: number;
  total_dislikes: number;
  total_replies: number;
  total_direct_replies: number;
  is_edited: boolean;
  is_pinned: boolean;
  is_picked: boolean;
  is_top_comment: boolean;
  metadata?: {
    origin_title?: string;
    origin_url?: string;
    origin_image_url?: string;
  };
}

export interface VfUser {
  uuid: string;
  preferred_username?: string;
  account_status?: string;
  vf_badges?: Record<string, unknown>;
  custom_badges?: Record<string, unknown>;
}

interface CommentPage {
  more_available: boolean;
  contents: VfComment[];
}

export interface ContainerRef {
  sectionUuid: string;
  containerUuid: string;
}

export class ViafouraError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`${status} from ${url}: ${body.slice(0, 200)}`);
    this.name = "ViafouraError";
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) throw new ViafouraError(res.status, url, await res.text());
  return (await res.json()) as T;
}

/** Newest-first page of root comments in a container. */
export async function listComments(
  { sectionUuid, containerUuid }: ContainerRef,
  opts: { limit?: number; startingFrom?: string; signal?: AbortSignal } = {},
): Promise<CommentPage> {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 50),
    reply_limit: "0",
    sorted_by: "newest",
  });
  if (opts.startingFrom) params.set("starting_from", opts.startingFrom);
  return getJson<CommentPage>(
    `${COMMENTS_API}/${sectionUuid}/${containerUuid}/comments?${params}`,
    opts.signal,
  );
}

/** Replies belonging to a root comment. */
export async function listReplies(
  { sectionUuid, containerUuid }: ContainerRef,
  threadUuid: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<CommentPage> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  return getJson<CommentPage>(
    `${COMMENTS_API}/${sectionUuid}/${containerUuid}/comments/${threadUuid}?${params}`,
    opts.signal,
  );
}

/**
 * Resolve a site-specific container id (GB News uses the RebelMouse post id,
 * exposed as `<meta name="vf:container_id">`) to a Viafoura container UUID.
 */
export async function resolveContainerId(
  sectionUuid: string,
  containerId: string,
  signal?: AbortSignal,
): Promise<string> {
  const params = new URLSearchParams({ container_id: containerId });
  const body = await getJson<{ content_container_uuid: string }>(
    `${COMMENTS_API}/${sectionUuid}/contentcontainer/id?${params}`,
    signal,
  );
  return body.content_container_uuid;
}

/** Pull the `vf:container_id` meta tag value out of a page's markup. */
export function parseContainerId(html: string): string | null {
  const match = html.match(/<meta[^>]+name=["']vf:container_id["'][^>]+content=["']([^"']+)["']/i);
  return match?.[1] ?? null;
}

/** Read the `vf:container_id` meta tag out of a GB News page. */
export async function containerIdFromPage(pageUrl: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(pageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; gbnews-watch)" },
    signal,
  });
  if (!res.ok) throw new ViafouraError(res.status, pageUrl, await res.text());
  const containerId = parseContainerId(await res.text());
  if (!containerId) throw new Error(`No vf:container_id meta tag found on ${pageUrl}`);
  return containerId;
}

/** Looks up display names, caching each author for the life of the process. */
export class UserDirectory {
  #cache = new Map<string, Promise<VfUser | null>>();

  constructor(private readonly sectionUuid: string) {}

  get(actorUuid: string, signal?: AbortSignal): Promise<VfUser | null> {
    const cached = this.#cache.get(actorUuid);
    if (cached) return cached;

    const pending = getJson<VfUser>(
      `${IAM_API}/sections/${this.sectionUuid}/users/${actorUuid}`,
      signal,
    ).catch(() => null);

    this.#cache.set(actorUuid, pending);
    return pending;
  }

  async displayName(actorUuid: string, signal?: AbortSignal): Promise<string> {
    const user = await this.get(actorUuid, signal);
    return user?.preferred_username || "Anonymous";
  }
}
