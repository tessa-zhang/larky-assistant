import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MS_PER_HOUR } from './time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_DIR = join(__dirname, '..', 'state');
// Per-user state lives in <STATE_DIR>/<open_id>.json so multiple users on one instance
// never clobber each other's done/snooze/digest-snapshot/cache (R2 multi-user — a single
// shared file let one user's `done`/`done all` act on another's digest). STATE_DIR is
// read lazily so a hosted deploy (or a test) can point it elsewhere at runtime.
const stateDir = () => process.env.STATE_DIR || DEFAULT_STATE_DIR;
// Pre-multi-user single-user file at the repo root, migrated into the first user's
// per-user file on load — but ONLY when using the default dir. A custom STATE_DIR
// (test / hosted volume) starts clean and never touches this legacy file.
const LEGACY_STATE_PATH = join(__dirname, '..', 'state.json');

/**
 * Per-user state file path. An open_id is `ou_`+hex, but sanitize defensively so a
 * malformed value can never escape the state dir via path traversal.
 */
function userStatePath(openId) {
  const safe = String(openId || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  return join(stateDir(), `${safe}.json`);
}

const EMPTY_STATE = {
  lastRunAt: null,
  doneMessageIds: [],
  snoozedMessages: [], // [{ messageId, snoozeUntil }]
  // Snapshot of the most recently delivered digest, so `done`/`snooze` can map
  // the numbers shown on the card to message_ids and re-render WITHOUT another
  // fetch/classify round-trip.
  lastDigest: null, // { generatedAt, since, items: [ normalized+classified item ] }
  // R2 token guard — per-thread summary cache (see SPEC R2 pre-launch gate).
  // { [cacheKey]: { urgency, category, summary, savedAt } }, keyed by
  // thread_id + newest thread position + my watermark (fetchMentions.threadCacheKey).
  threadSummaryCache: {},
};

export async function load(openId) {
  await mkdir(stateDir(), { recursive: true });
  const p = userStatePath(openId);
  // One-time migration from the pre-multi-user single file: the FIRST user to load
  // inherits it (that's this instance's original single-user owner). Rename it into
  // their per-user file — a move, so no second user picks it up, and it replaces any
  // stale prototype file for that id. Gated to the default dir so a custom STATE_DIR
  // (test / hosted volume) never touches it; new/hosted deploys have no legacy file.
  if (!process.env.STATE_DIR && existsSync(LEGACY_STATE_PATH)) {
    try { await rename(LEGACY_STATE_PATH, p); } catch { /* raced by a concurrent load — fall through */ }
  }
  if (!existsSync(p)) return { ...EMPTY_STATE };
  try {
    const raw = await readFile(p, 'utf8');
    return { ...EMPTY_STATE, ...JSON.parse(raw) };
  } catch (err) {
    throw new Error(`state for ${openId} is corrupt (${err.message}). Fix or delete ${p}.`);
  }
}

export async function save(openId, state) {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(userStatePath(openId), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** Drop snoozes whose timer has elapsed. Mutates + returns state. */
export function clearExpiredSnoozes(state, now = new Date()) {
  const cutoff = now.getTime();
  state.snoozedMessages = (state.snoozedMessages || []).filter(
    (s) => new Date(s.snoozeUntil).getTime() > cutoff,
  );
  return state;
}

/** Set of message_ids currently hidden (done or actively snoozed). */
export function hiddenMessageIds(state) {
  const set = new Set(state.doneMessageIds || []);
  for (const s of state.snoozedMessages || []) set.add(s.messageId);
  return set;
}

export function markDone(state, messageIds) {
  const set = new Set(state.doneMessageIds || []);
  for (const id of messageIds) set.add(id);
  state.doneMessageIds = [...set];
  // A done item should never also be snoozed.
  state.snoozedMessages = (state.snoozedMessages || []).filter(
    (s) => !messageIds.includes(s.messageId),
  );
  return state;
}

export function snooze(state, messageIds, hours, now = new Date()) {
  const snoozeUntil = new Date(now.getTime() + hours * MS_PER_HOUR).toISOString();
  const byId = new Map((state.snoozedMessages || []).map((s) => [s.messageId, s]));
  for (const id of messageIds) byId.set(id, { messageId: id, snoozeUntil });
  state.snoozedMessages = [...byId.values()];
  return state;
}

/**
 * R2 token guard — per-thread summary cache (see SPEC R2 pre-launch gate).
 * Stores a thread row's classification keyed by thread_id + newest thread position
 * + my watermark (fetchMentions.threadCacheKey). An unchanged thread on a later run
 * reuses the stored answer with ZERO Anthropic tokens — the dominant cost lever once
 * many colleagues use this and every stateless run re-summarises the whole backlog.
 */

/** Cached classification for `key`, or null. Refreshes recency on hit so live threads stay warm. */
export function getCachedSummary(state, key, now = new Date()) {
  const hit = key && state.threadSummaryCache?.[key];
  if (!hit) return null;
  hit.savedAt = now.toISOString();
  return { urgency: hit.urgency, category: hit.category, summary: hit.summary };
}

/** Store a classification under its cache key. */
export function setCachedSummary(state, key, { urgency, category, summary }, now = new Date()) {
  if (!key) return state;
  (state.threadSummaryCache ||= {})[key] = { urgency, category, summary, savedAt: now.toISOString() };
  return state;
}

/**
 * Drop cache entries older than `ttlHours` — orphaned keys (a thread advanced, so
 * its old key never matches again) age out, keeping the cache bounded. `ttlHours <= 0`
 * clears the whole cache (the THREAD_CACHE_TTL_HOURS=0 kill switch).
 */
export function pruneSummaryCache(state, ttlHours, now = new Date()) {
  const cache = state.threadSummaryCache || {};
  if (!(ttlHours > 0)) { state.threadSummaryCache = {}; return state; }
  const cutoff = now.getTime() - ttlHours * MS_PER_HOUR;
  for (const [k, v] of Object.entries(cache)) {
    if (!v?.savedAt || new Date(v.savedAt).getTime() < cutoff) delete cache[k];
  }
  state.threadSummaryCache = cache;
  return state;
}
