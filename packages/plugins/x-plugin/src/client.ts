import { errorMessage, isRecord, isUnknownArray, toUtcIsoDate } from "@mulmoclaude/common";
import { fetchWithTimeout, ONE_SECOND_MS, safeResponseText } from "./internal";

const X_API_BASE = "https://api.twitter.com/2";

// X API can stall under rate limit — a 10 s default (used for internal
// localhost calls) would produce false timeouts. 20 s gives enough
// headroom for a slow but real response while still bailing long
// before the MCP client's tool-call timeout fires.
export const X_API_TIMEOUT_MS = 20 * ONE_SECOND_MS;

export const TWEET_FIELDS = "tweet.fields=created_at,author_id,public_metrics,entities,note_tweet,article";
export const EXPANSIONS = "expansions=author_id";
export const USER_FIELDS = "user.fields=name,username";

export interface XUser {
  id: string;
  name: string;
  username: string;
}

export interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  // Long-form Post (>280 chars): full body lives here, not in `text`.
  note_tweet?: { text: string };
  // X Article (rich long-form, up to 100k chars): `text` only holds the t.co
  // link, so the body must be read from `article.plain_text`.
  article?: { title?: string; plain_text?: string };
  public_metrics?: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
  };
}

export interface XApiResponse {
  data?: XTweet | XTweet[];
  includes?: { users?: XUser[] };
  errors?: { detail: string }[];
  meta?: { result_count: number };
}

/** Resolve the X API bearer token from the environment. The host gates the
 *  tools on `requiredEnv: ["X_BEARER_TOKEN"]` before dispatch, but the body
 *  re-checks so direct/test callers get a clear error. */
export function xBearerToken(): string | undefined {
  return process.env.X_BEARER_TOKEN;
}

const readString = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
};

const readNumber = (source: Record<string, unknown>, key: string): number | undefined => {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
};

function toXUser(value: unknown): XUser | null {
  if (!isRecord(value)) return null;
  const userId = readString(value, "id");
  const name = readString(value, "name");
  const username = readString(value, "username");
  if (userId === undefined || name === undefined || username === undefined) return null;
  return { id: userId, name, username };
}

function toNoteTweet(value: unknown): XTweet["note_tweet"] {
  if (!isRecord(value)) return undefined;
  const text = readString(value, "text");
  return text === undefined ? undefined : { text };
}

function toArticle(value: unknown): XTweet["article"] {
  if (!isRecord(value)) return undefined;
  return { title: readString(value, "title"), plain_text: readString(value, "plain_text") };
}

function toPublicMetrics(value: unknown): XTweet["public_metrics"] {
  if (!isRecord(value)) return undefined;
  const like_count = readNumber(value, "like_count");
  const retweet_count = readNumber(value, "retweet_count");
  const reply_count = readNumber(value, "reply_count");
  if (like_count === undefined || retweet_count === undefined || reply_count === undefined) return undefined;
  return { like_count, retweet_count, reply_count };
}

function toXTweet(value: unknown): XTweet | null {
  if (!isRecord(value)) return null;
  const tweetId = readString(value, "id");
  const text = readString(value, "text");
  if (tweetId === undefined || text === undefined) return null;
  return {
    id: tweetId,
    text,
    author_id: readString(value, "author_id"),
    created_at: readString(value, "created_at"),
    note_tweet: toNoteTweet(value.note_tweet),
    article: toArticle(value.article),
    public_metrics: toPublicMetrics(value.public_metrics),
  };
}

function toXErrors(value: unknown): { detail: string }[] | undefined {
  if (!isUnknownArray(value)) return undefined;
  return value.flatMap((item) => {
    const detail = isRecord(item) ? readString(item, "detail") : undefined;
    return detail === undefined ? [] : [{ detail }];
  });
}

function toXIncludes(value: unknown): XApiResponse["includes"] {
  if (!isRecord(value) || !isUnknownArray(value.users)) return undefined;
  return { users: value.users.flatMap((user) => toXUser(user) ?? []) };
}

function toXMeta(value: unknown): XApiResponse["meta"] {
  if (!isRecord(value)) return undefined;
  const result_count = readNumber(value, "result_count");
  return result_count === undefined ? undefined : { result_count };
}

/** Rebuild the response from the fields we can prove. Every member of
 *  `XApiResponse` is optional, so an unrecognised body degrades to `{}`
 *  and the tools report "not found" / "no results" instead of formatting
 *  a half-shaped tweet. */
export function parseXApiResponse(json: unknown): XApiResponse {
  if (!isRecord(json)) return {};
  return {
    data: isUnknownArray(json.data) ? json.data.flatMap((item) => toXTweet(item) ?? []) : (toXTweet(json.data) ?? undefined),
    includes: toXIncludes(json.includes),
    errors: toXErrors(json.errors),
    meta: toXMeta(json.meta),
  };
}

export async function fetchX(path: string): Promise<XApiResponse> {
  const token = xBearerToken();
  if (!token) throw new Error("X_BEARER_TOKEN is not configured in .env");

  let response: Response;
  try {
    response = await fetchWithTimeout(`${X_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: X_API_TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(`Network error calling X API: ${errorMessage(err)}`);
  }

  if (response.status === 401) throw new Error("X API error 401: Invalid or expired Bearer Token.");
  if (response.status === 429) throw new Error("X API error 429: Rate limit exceeded. Please wait before retrying.");
  if (!response.ok) {
    const body = await safeResponseText(response);
    throw new Error(`X API error ${response.status}: ${body}`);
  }

  return parseXApiResponse(await response.json());
}

// `text` caps at 280 chars; long-form Posts and Articles carry their real body
// in `note_tweet` / `article`. Prefer those so the LLM sees the full content.
export function tweetBody(tweet: XTweet): string {
  if (tweet.note_tweet?.text) return tweet.note_tweet.text;
  const { article } = tweet;
  if (article?.plain_text) {
    return [article.title, article.plain_text].filter(Boolean).join("\n\n");
  }
  return tweet.text;
}

export function formatTweet(tweet: XTweet, author?: XUser, url?: string): string {
  const date = tweet.created_at ? toUtcIsoDate(new Date(tweet.created_at)) : "";
  const dateSuffix = date ? ` · ${date}` : "";
  const byline = author ? `@${author.username} (${author.name})${dateSuffix}` : date;
  const metrics = tweet.public_metrics
    ? `Likes: ${tweet.public_metrics.like_count} | Retweets: ${tweet.public_metrics.retweet_count} | Replies: ${tweet.public_metrics.reply_count}`
    : "";
  const link = url ?? "";
  return [byline, "", tweetBody(tweet), "", metrics, link]
    .filter((line) => line !== undefined)
    .join("\n")
    .trimEnd();
}

/** Extract a numeric tweet id from a full x.com/twitter.com status URL or a
 *  bare id. Returns null when neither form matches. */
export function extractTweetId(url: string): string | null {
  const match = url.match(/status\/(\d+)/);
  if (match) return match[1];
  return /^\d+$/.test(url) ? url : null;
}
