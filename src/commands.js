import { config, URGENCY_ORDER } from './config.js';
import { sendMessage } from './lark.js';
import { buildDigestCard } from './buildCard.js';
import { fetchSince, isAutomatedSender } from './fetchMentions.js';
import { classify } from './classify.js';
import { formatDate, MS_PER_HOUR } from './time.js';
import * as store from './state.js';

/** Send text or an interactive card to the configured target. */
async function deliver(delivery, content, msgType = 'text') {
  return sendMessage({
    as: delivery.as,
    userId: delivery.userId,
    chatId: delivery.chatId,
    content,
    msgType,
  });
}

/**
 * Sort into the card's reading order and assign 1..N (the numbers `done`/`snooze`
 * reference), so numbering stays monotonic top-to-bottom:
 *   1. **humans before bots/apps** — bot/app items live in their own bottom section
 *      (2026-08-11), so this is the section split, not a tie-break;
 *   2. urgency (high→low) within each side;
 *   3. most-recent first.
 * The bot section is deliberately ordered by urgency too, so its own HIGH sits on top.
 */
export function numberItems(items) {
  items.sort((a, b) => {
    const bot = Number(isAutomatedSender(a)) - Number(isAutomatedSender(b));
    if (bot !== 0) return bot;
    const u = (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9);
    if (u !== 0) return u;
    return (b.createTime?.getTime?.() || 0) - (a.createTime?.getTime?.() || 0);
  });
  items.forEach((it, i) => { it.n = i + 1; });
  return items;
}

/** Sorted, deduped messageIds — a cheap fingerprint of "what's currently unread". */
export function pollSignature(items) {
  return [...new Set(items.map((it) => it.messageId))].sort();
}

function signaturesEqual(a, b) {
  return !!a && !!b && a.length === b.length && a.every((id, i) => id === b[i]);
}

function rehydrate(items) {
  for (const it of items || []) {
    if (it.createTime && !(it.createTime instanceof Date)) it.createTime = new Date(it.createTime);
  }
  return items || [];
}

// Start of the fetch window: a FIXED lookback from now, independent of when the
// digest last ran. Running a digest doesn't read anything, so each run must
// re-surface the whole current unread backlog within the window (cleared only by
// replying, `done`, or `snooze`) — not just messages newer than the last run.
function startWindow() {
  return new Date(Date.now() - config.lookbackHours * MS_PER_HOUR).toISOString();
}

/**
 * Full digest run: fetch → classify → card. Persists lastRunAt + a snapshot of
 * the delivered items so done/snooze can act without re-fetching.
 */
export async function runDigest({ self, delivery, footerHint, ack = false, requireChange = false }) {
  const state = store.clearExpiredSnoozes(await store.load(self.openId));
  const since = startWindow();
  const sinceDate = new Date(since); // fixed lookback window start
  const runAt = new Date();

  if (ack) await deliver(delivery, '⏳ Priotising your mentions, give me a moment…');

  const { items, skipped } = await fetchSince(since, self, state);

  // R12 auto-poll change-gate: a scheduled tick only sends when the unread set
  // actually moved since the last check — cheap (post-fetch, pre-classify), so
  // an unchanged backlog costs no Claude tokens and never re-clutters the DM
  // thread with a near-duplicate card. Manual triggers (`n`, npm run inlark)
  // never set requireChange, so a person asking for the digest always gets one.
  const signature = pollSignature(items);
  if (requireChange && state.lastPollSignature !== null && signaturesEqual(signature, state.lastPollSignature)) {
    state.lastRunAt = runAt.toISOString();
    state.lastPollAt = runAt.toISOString();
    await store.save(self.openId, state);
    return { count: items.length, sent: false, skipped };
  }
  state.lastPollSignature = signature;
  if (requireChange) state.lastPollAt = runAt.toISOString();

  if (items.length === 0) {
    await deliver(delivery, `✅ You're all caught up! No new unread mentions or DMs since ${formatDate(sinceDate)}.`);
    state.lastRunAt = runAt.toISOString();
    state.lastDigest = { generatedAt: runAt.toISOString(), since, items: [] };
    await store.save(self.openId, state);
    return { count: 0, skipped };
  }

  // R2 token guard: reuse cached per-thread summaries so an UNCHANGED thread costs
  // ZERO Anthropic tokens (the dominant cost lever at multi-user scale — see SPEC R2
  // pre-launch gate). Only thread-bundle rows carry a `cacheKey`; the token-free Lark
  // thread fetch already ran (it's how we know the thread is unchanged). ttl<=0 is a
  // kill switch: prune clears the cache and we classify everything.
  const cacheOn = config.threadCacheTtlHours > 0;
  store.pruneSummaryCache(state, config.threadCacheTtlHours);
  const toClassify = [];
  let cachedCount = 0;
  for (const it of items) {
    const hit = cacheOn && it.cacheKey ? store.getCachedSummary(state, it.cacheKey) : null;
    if (hit) { Object.assign(it, hit); cachedCount++; }
    else toClassify.push(it);
  }

  const classified = await classify(toClassify, { userName: self.userName });
  for (const it of toClassify) {
    const c = classified.get(it.messageId);
    Object.assign(it, c);
    if (cacheOn && it.cacheKey) store.setCachedSummary(state, it.cacheKey, c); // reuse next run
  }

  // NOTHING is filtered out of the card (2026-08-11, reverting the same-day action-only
  // experiment): every fetched item is rendered. Humans keep their full HIGH / MEDIUM /
  // LOW-FYI grouping (LOW collapsed behind the R3 panel, as before the experiment), and
  // bot/app rows keep their own section — also at every urgency. The action-only filter
  // dropped human `low` rows entirely; Tessa asked for them back, so the only structural
  // change left from these sessions is the bot/human SPLIT, not any hiding. Keep it that
  // way: `urgency: "low"` is once again purely an ordering/grouping signal, never an
  // include/exclude gate, which is what makes a mis-classification recoverable rather
  // than invisible. See SPEC "Digest card".
  numberItems(items);

  // The bundle + cache bookkeeping were only needed for classification; drop them so
  // the snapshot done/snooze re-renders from stays lean (it keeps bundleType/threadTopic).
  for (const it of items) { delete it.bundle; delete it.cacheKey; }

  const card = buildDigestCard({ items, since: sinceDate, generatedAt: runAt, footerHint });
  await deliver(delivery, card, 'interactive');

  state.lastRunAt = runAt.toISOString();
  state.lastDigest = { generatedAt: runAt.toISOString(), since, items };
  await store.save(self.openId, state);
  return { count: items.length, cached: cachedCount, skipped };
}

/** Resolve card numbers → items from the last delivered digest. */
function resolveNumbers(state, numbers) {
  const items = rehydrate(state.lastDigest?.items || []);
  const byN = new Map(items.map((it) => [it.n, it]));
  const matched = [];
  const invalid = [];
  for (const n of numbers) {
    const it = byN.get(n);
    if (it) matched.push(it);
    else invalid.push(n);
  }
  return { items, matched, invalid };
}

/** Re-render the remaining (non-hidden) items as a fresh card and persist. */
async function rerender(userId, state, delivery, footerHint) {
  const hidden = store.hiddenMessageIds(state);
  let remaining = rehydrate(state.lastDigest?.items || []).filter((it) => !hidden.has(it.messageId));
  numberItems(remaining);
  state.lastDigest = { ...state.lastDigest, items: remaining };
  // Keep the poll change-gate in sync with what done/snooze just cleared, so the
  // next scheduled tick doesn't mistake this self-caused shrink for an external
  // change and re-send a card for items Tessa just dismissed.
  if (state.lastPollSignature !== null) state.lastPollSignature = pollSignature(remaining);
  await store.save(userId, state);
  if (remaining.length === 0) {
    await deliver(delivery, '✅ All clear — nothing left in this digest.');
    return;
  }
  const card = buildDigestCard({
    items: remaining,
    since: state.lastDigest.since ? new Date(state.lastDigest.since) : null,
    generatedAt: new Date(),
    footerHint,
  });
  await deliver(delivery, card, 'interactive');
}

const noMatchMessage = (numbers) =>
  `⚠️ No matching items for: ${numbers.join(', ')}. Run a digest first, then reference the numbers shown.`;

/**
 * Shared done/snooze flow: resolve card numbers → apply `mutate` → confirm →
 * re-render the survivors. `confirm(refs)` builds the action-specific message.
 */
async function applyToMatched({ userId, delivery, footerHint, numbers, all, mutate, confirm }) {
  const state = store.clearExpiredSnoozes(await store.load(userId));
  let matched;
  let invalid = [];
  if (all) {
    // `all` clears every item in the last delivered digest. Safe by construction: the
    // card lists every item (no display cap — LOW is only collapsed, its full contents
    // reachable by expanding), so the snapshot IS exactly what the user can see. We never
    // clear something unreachable.
    matched = rehydrate(state.lastDigest?.items || []);
  } else {
    ({ matched, invalid } = resolveNumbers(state, numbers));
  }
  if (matched.length === 0) {
    await deliver(delivery, all ? '✅ Nothing to clear — run a `digest` first.' : noMatchMessage(numbers));
    return { affected: 0, invalid };
  }
  mutate(state, matched.map((it) => it.messageId));
  const refs = all ? `all ${matched.length} item${matched.length === 1 ? '' : 's'}` : matched.map((it) => `#${it.n}`).join(', ');
  const tail = invalid.length ? ` (no item: ${invalid.join(', ')})` : '';
  await deliver(delivery, confirm(refs) + tail);
  await rerender(userId, state, delivery, footerHint);
  return { affected: matched.length, invalid };
}

export function runDone({ userId, delivery, footerHint, numbers, all }) {
  return applyToMatched({
    userId, delivery, footerHint, numbers, all,
    mutate: store.markDone,
    confirm: (refs) => `✅ Marked ${refs} as done.`,
  });
}

export function runSnooze({ userId, delivery, footerHint, numbers, all }) {
  return applyToMatched({
    userId, delivery, footerHint, numbers, all,
    mutate: (state, ids) => store.snooze(state, ids, config.snoozeHours),
    confirm: (refs) => `😴 Snoozed ${refs} for ${config.snoozeHours}h.`,
  });
}
