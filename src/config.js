import 'dotenv/config';

/**
 * Central configuration + constants.
 *
 * Lark authentication is owned by lark-cli (token storage + refresh), so there
 * are no Lark secrets here — only behavioural knobs and the noise-exclusion
 * rules from the build spec.
 */

export const config = {
  // Identity used to deliver the digest card. See .env.example.
  sendAs: (process.env.SEND_AS || 'user').toLowerCase(),

  // Claude model for classification.
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',

  // Max lookback window for any run. Every digest is capped to this many hours
  // (start = later of lastRunAt and now-lookback), so you never get a large
  // backlog of older — likely-already-read — items. Default 24h.
  lookbackHours: Number(process.env.LOOKBACK_HOURS || (process.env.LOOKBACK_DAYS ? Number(process.env.LOOKBACK_DAYS) * 24 : 24)),

  // How far back to look for the user's own messages when building the reply
  // watermark (so a reply just before the digest window still counts as "read").
  watermarkLookbackDays: Number(process.env.WATERMARK_LOOKBACK_DAYS || 14),

  // Snooze duration.
  snoozeHours: Number(process.env.SNOOZE_HOURS || 24),

  // Optional explicit open_id; otherwise auto-detected from auth status.
  userOpenId: process.env.LARK_USER_OPEN_ID || null,

  // Soft cap on messages fetched per run (rate-limit guard).
  maxMessages: Number(process.env.MAX_MESSAGES || 200),

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  // Max LOW/FYI items rendered on the card (high/medium always shown in full);
  // the rest are summarised as "+N more". Keeps a busy digest readable.
  lowDisplayLimit: Number(process.env.LOW_DISPLAY_LIMIT || 10),
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
  /\|\s*Slack$/i, // Slack-mirrored channels, e.g. "something | Slack"
];

export function isExcludedChatName(name) {
  if (!name) return false;
  return EXCLUDE_CHAT_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

// Urgency ordering for sorting / grouping.
export const URGENCY_ORDER = { high: 0, medium: 1, low: 2 };

export const URGENCY_META = {
  high: { emoji: '🔴', label: 'HIGH PRIORITY', headerTemplate: 'red' },
  medium: { emoji: '🟡', label: 'MEDIUM', headerTemplate: 'orange' },
  low: { emoji: '🟢', label: 'LOW / FYI', headerTemplate: 'green' },
};

export const CATEGORY_LABEL = {
  incident: 'incident',
  decision_needed: 'decision_needed',
  review_request: 'review_request',
  question: 'question',
  fyi: 'fyi',
};
