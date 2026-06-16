import { config, URGENCY_ORDER } from './config.js';
import { sendMessage } from './lark.js';
import { buildDigestCard } from './buildCard.js';
import { fetchSince } from './fetchMentions.js';
import { classify } from './classify.js';
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

/** Sort by urgency (high→low) then most-recent, and assign 1..N. */
function numberItems(items) {
  items.sort((a, b) => {
    const u = (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9);
    if (u !== 0) return u;
    return (b.createTime?.getTime?.() || 0) - (a.createTime?.getTime?.() || 0);
  });
  items.forEach((it, i) => { it.n = i + 1; });
  return items;
}

function rehydrate(items) {
  for (const it of items || []) {
    if (it.createTime && !(it.createTime instanceof Date)) it.createTime = new Date(it.createTime);
  }
  return items || [];
}

// Start of the fetch window: the later of lastRunAt and the lookback cap, so a
// single run never reaches back further than `lookbackHours` (no big backlog).
function startWindow(state) {
  const cap = new Date(Date.now() - config.lookbackHours * 3600e3).toISOString();
  return state.lastRunAt && state.lastRunAt > cap ? state.lastRunAt : cap;
}

/**
 * Full digest run: fetch → classify → card. Persists lastRunAt + a snapshot of
 * the delivered items so done/snooze can act without re-fetching.
 */
export async function runDigest({ self, delivery, footerHint, ack = false }) {
  const state = store.clearExpiredSnoozes(await store.load());
  const since = startWindow(state);
  const sinceDate = new Date(since); // actual window start (capped)
  const runAt = new Date();

  if (ack) await deliver(delivery, '⏳ Fetching your mentions, give me a moment…');

  const { items, skipped } = await fetchSince(since, self, state);

  if (items.length === 0) {
    const when = sinceDate.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    await deliver(delivery, `✅ You're all caught up! No new unread mentions or DMs since ${when}.`);
    state.lastRunAt = runAt.toISOString();
    state.lastDigest = { generatedAt: runAt.toISOString(), since, items: [] };
    await store.save(state);
    return { count: 0, skipped };
  }

  const classified = await classify(items);
  for (const it of items) Object.assign(it, classified.get(it.messageId));
  numberItems(items);

  const card = buildDigestCard({ items, since: sinceDate, generatedAt: runAt, footerHint });
  await deliver(delivery, card, 'interactive');

  state.lastRunAt = runAt.toISOString();
  state.lastDigest = { generatedAt: runAt.toISOString(), since, items };
  await store.save(state);
  return { count: items.length, skipped };
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
async function rerender(state, delivery, footerHint) {
  const hidden = store.hiddenMessageIds(state);
  let remaining = rehydrate(state.lastDigest?.items || []).filter((it) => !hidden.has(it.messageId));
  numberItems(remaining);
  state.lastDigest = { ...state.lastDigest, items: remaining };
  await store.save(state);
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

export async function runDone({ delivery, footerHint, numbers }) {
  const state = store.clearExpiredSnoozes(await store.load());
  const { matched, invalid } = resolveNumbers(state, numbers);
  if (matched.length === 0) {
    await deliver(delivery, `⚠️ No matching items for: ${numbers.join(', ')}. Run a digest first, then reference the numbers shown.`);
    return { done: 0, invalid };
  }
  store.markDone(state, matched.map((it) => it.messageId));
  const summary = matched.map((it) => `#${it.n}`).join(', ');
  await deliver(delivery, `✅ Marked ${summary} as done.${invalid.length ? ` (no item: ${invalid.join(', ')})` : ''}`);
  await rerender(state, delivery, footerHint);
  return { done: matched.length, invalid };
}

export async function runSnooze({ delivery, footerHint, numbers }) {
  const state = store.clearExpiredSnoozes(await store.load());
  const { matched, invalid } = resolveNumbers(state, numbers);
  if (matched.length === 0) {
    await deliver(delivery, `⚠️ No matching items for: ${numbers.join(', ')}. Run a digest first, then reference the numbers shown.`);
    return { snoozed: 0, invalid };
  }
  store.snooze(state, matched.map((it) => it.messageId), config.snoozeHours);
  const summary = matched.map((it) => `#${it.n}`).join(', ');
  await deliver(delivery, `😴 Snoozed ${summary} for ${config.snoozeHours}h.${invalid.length ? ` (no item: ${invalid.join(', ')})` : ''}`);
  await rerender(state, delivery, footerHint);
  return { snoozed: matched.length, invalid };
}
