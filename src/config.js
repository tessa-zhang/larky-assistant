import 'dotenv/config';

/**
 * Central configuration + constants.
 *
 * Lark authentication is owned by lark-cli (token storage + refresh), so there
 * are no Lark secrets here — only behavioural knobs and the noise-exclusion
 * rules from the build spec.
 */

export const config = {
  // Identity used to deliver the digest card. Default `bot` — the R2 hosted
  // surface (verified live 2026-08-04). `user` (self-chat) is deprecated, kept
  // only as a manual CLI fallback. See .env.example.
  sendAs: (process.env.SEND_AS || 'bot').toLowerCase(),

  // Model for classification, as named on Traveloka's LiteLLM allow-list.
  // Classify.js now talks to LiteLLM's OpenAI-compatible endpoint, so this
  // can be ANY provider the key is allow-listed for — Claude, GPT, Gemini,
  // DeepSeek, etc. (var kept as CLAUDE_MODEL for backwards compat with
  // existing .env files; it's a historical label, not a provider lock-in.)
  // Run `npm run probe-models` to list ids this key can actually hit.
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5',

  // Fixed lookback window for every run: each digest scans the last N hours for
  // CURRENTLY-unread mentions/DMs — independent of when you last ran it. Running
  // a digest does not mark anything read, so the unread backlog must persist
  // across runs (cleared only by replying, `done`, or `snooze`). Default 168h (7d)
  // — a week matches how most people keep their inbox clear; tune per role/taste.
  // NB: this is a ROLLING window (start = now − N), so items still slide off the
  // far edge as time passes; a stable weekly anchor is the parked follow-up (R8).
  lookbackHours: Number(process.env.LOOKBACK_HOURS || (process.env.LOOKBACK_DAYS ? Number(process.env.LOOKBACK_DAYS) * 24 : 168)),

  // How far back to look for the user's own messages when building the reply
  // watermark (so a reply just before the digest window still counts as "read").
  watermarkLookbackDays: Number(process.env.WATERMARK_LOOKBACK_DAYS || 14),

  // Snooze duration.
  snoozeHours: Number(process.env.SNOOZE_HOURS || 24),

  // Optional explicit open_id; otherwise auto-detected from auth status.
  userOpenId: process.env.LARK_USER_OPEN_ID || null,

  // Soft cap on messages fetched per run (rate-limit guard).
  maxMessages: Number(process.env.MAX_MESSAGES || 200),

  // LiteLLM proxy credentials for classification — Traveloka's IT-listed
  // AI gateway. Both required; classify.js sends anthropicApiKey as a Bearer
  // token against LiteLLM's OpenAI-compatible /v1/chat/completions endpoint.
  // Field names kept as anthropic* for backwards compat with existing .env
  // files — they're historical labels, the endpoint is provider-agnostic.
  // Missing either degrades classification to the heuristic-free low/fyi
  // fallback rather than crashing. See SPEC "Privacy & data handling".
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBaseUrl: (process.env.ANTHROPIC_BASE_URL || '').trim(),

  // Characters of the verbatim message shown beneath the AI summary on each card
  // item (≈2 lines on a wide card). The exact wording, so you can triage without
  // opening the chat (which would mark it read).
  rawPreviewChars: Number(process.env.RAW_PREVIEW_CHARS || 160),

  // --- R6: multi-message / thread-summary bundling -------------------------
  // Each digest row can summarise a *bundle* of unread messages, not just the
  // latest one: a DM's unread run, or a group thread's discussion. To keep token
  // spend ~flat per row regardless of how long a thread is (it balloons fast once
  // many colleagues use this), we fetch the thread but only send Claude a SALIENT
  // SLICE — thread head + the neighbourhood around each @mention + the unread tail
  // — capped and per-message-truncated. See fetchMentions.buildThreadSlice + SPEC R6.
  //
  // Max messages from a single bundle sent to Claude (recency-biased; older middle
  // is elided with a marker). The ballooning fix: a 6-msg thread and a 300-msg
  // thread both cost ~this many messages.
  threadBundleMaxMsgs: Number(process.env.THREAD_BUNDLE_MAX_MSGS || 8),
  // Messages from the START of a thread always kept (what the thread is about).
  threadHeadMsgs: Number(process.env.THREAD_HEAD_MSGS || 2),
  // Messages kept on each side of an @mention (the ask + local context).
  threadAroundMention: Number(process.env.THREAD_AROUND_MENTION || 2),
  // Max messages in a DM's unread-run bundle (DMs are fetched already — no extra call).
  dmBundleMaxMsgs: Number(process.env.DM_BUNDLE_MAX_MSGS || 10),
  // Per-message char cap INSIDE a bundle (chat lines are short; one wall-of-text
  // message shouldn't dominate the slice). Single-message items keep the larger 2000.
  bundleMsgChars: Number(process.env.BUNDLE_MSG_CHARS || 300),
  // Page size for the thread fetch (one `desc` call → newest N). Threads ≤ this come
  // back whole; longer ones return the recent tail (which holds the @mention + unread
  // run) — the head may be missing then, which the slice tolerates. NB: lark-cli's
  // --help claims a 500 max, but the underlying Lark thread API really caps page_size
  // at 50 — asking for more silently returns ZERO messages (verified 2026-06-24). The
  // wrapper clamps to 50; don't raise this past it or thread bundling fails open.
  threadFetchPageSize: Number(process.env.THREAD_FETCH_PAGE_SIZE || 50),
  // Fetch-on-demand gate: skip the thread fetch when the @-line is already
  // self-contained — a single @mention whose text is at least this long. Threads
  // with multiple @-lines always fetch (a multi-message ask). 0 disables the gate.
  threadGateChars: Number(process.env.THREAD_GATE_CHARS || 140),

  // --- R2 pre-launch token guard: per-thread summary cache --------------------
  // Cache each thread row's CLASSIFICATION (urgency/category/summary — the
  // expensive Anthropic output), keyed by thread_id + newest thread position + my
  // per-thread watermark (see fetchMentions.threadCacheKey). On a later run an
  // UNCHANGED thread (no new messages, and I haven't replied) reuses the stored
  // summary with ZERO Anthropic tokens — the dominant cost lever once colleagues
  // use this and every stateless run re-summarises the whole backlog. The
  // token-free Lark thread fetch still runs (it's how we detect "unchanged"); only
  // the Claude call is skipped. Per-user by construction (the cache lives in that
  // user's state and the key encodes my watermark). Entries self-orphan as a thread
  // advances, so a TTL ages orphans out to keep the cache bounded. Default 14d
  // (matches the watermark lookback — a thread untouched that long won't resurface).
  // Set THREAD_CACHE_TTL_HOURS=0 to disable the cache (kill switch).
  threadCacheTtlHours: Number(process.env.THREAD_CACHE_TTL_HOURS ?? 24 * 14),
};

/**
 * Known system / noise channels to always exclude, by chat name.
 * Note: applying these requires resolving chat_id -> chat name, which needs the
 * bot capability + im:chat:readonly. When name resolution is unavailable these
 * are skipped gracefully (the --is-at-me + exclude-bot-senders search filters
 * already remove the bulk of automated noise).
 */
export const EXCLUDE_CHAT_NAME_PATTERNS = [
  /^unbookable-item-alert-/i,
  /^cross-sell-null-item-alert-/i,
  /^merchandising_oncall$/i,
  /^release-and-hotfix$/i,
  /^promo-error-report$/i,
  // NB: the `… | Slack` (Slack-mirrored) pattern was removed 2026-07-02 — those turned
  // out to be real human coordination channels, not noise. Tighten again only with cause.
];

export function isExcludedChatName(name) {
  if (!name) return false;
  return EXCLUDE_CHAT_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

// Urgency ordering for sorting / grouping.
export const URGENCY_ORDER = { high: 0, medium: 1, low: 2 };

export const URGENCY_META = {
  high: { emoji: '🔴', label: 'HIGH PRIORITY' },
  medium: { emoji: '🟡', label: 'MEDIUM' },
  low: { emoji: '🟢', label: 'LOW / FYI' },
};

// Bot/app items are grouped into their OWN section rather than into the urgency
// buckets (2026-08-11) — an automated ping never sits among human asks, whatever it
// classifies as. Same shape as URGENCY_META so the card renders the section the same way.
export const BOT_SECTION_META = { emoji: '🤖', label: 'BOT / APP' };
