import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MS_PER_HOUR } from './time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, '..', 'state.json');

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

export async function load() {
  if (!existsSync(STATE_PATH)) return { ...EMPTY_STATE };
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY_STATE, ...parsed };
  } catch (err) {
    throw new Error(`state.json is corrupt (${err.message}). Fix or delete it.`);
  }
}

export async function save(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
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
