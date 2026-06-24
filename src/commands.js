import { config, URGENCY_ORDER } from './config.js';
import { sendMessage } from './lark.js';
import { buildDigestCard } from './buildCard.js';
import { fetchSince } from './fetchMentions.js';
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
export async function runDigest({ self, delivery, footerHint, ack = false }) {
  const state = store.clearExpiredSnoozes(await store.load());
  const since = startWindow();
  const sinceDate = new Date(since); // fixed lookback window start
  const runAt = new Date();

  if (ack) await deliver(delivery, '⏳ Fetching your mentions, give me a moment…');

  const { items, skipped } = await fetchSince(since, self, state);

  if (items.length === 0) {
    await deliver(delivery, `✅ You're all caught up! No new unread mentions or DMs since ${formatDate(sinceDate)}.`);
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

  // The bundle (DM run / thread slice) was only needed to classify; drop it so the
  // snapshot done/snooze re-renders from stays lean (it keeps bundleType/threadTopic).
  for (const it of items) delete it.bundle;
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

const noMatchMessage = (numbers) =>
  `⚠️ No matching items for: ${numbers.join(', ')}. Run a digest first, then reference the numbers shown.`;

/**
 * Shared done/snooze flow: resolve card numbers → apply `mutate` → confirm →
 * re-render the survivors. `confirm(refs)` builds the action-specific message.
 */
async function applyToMatched({ delivery, footerHint, numbers, mutate, confirm }) {
  const state = store.clearExpiredSnoozes(await store.load());
  const { matched, invalid } = resolveNumbers(state, numbers);
  if (matched.length === 0) {
    await deliver(delivery, noMatchMessage(numbers));
    return { affected: 0, invalid };
  }
  mutate(state, matched.map((it) => it.messageId));
  const refs = matched.map((it) => `#${it.n}`).join(', ');
  const tail = invalid.length ? ` (no item: ${invalid.join(', ')})` : '';
  await deliver(delivery, confirm(refs) + tail);
  await rerender(state, delivery, footerHint);
  return { affected: matched.length, invalid };
}

export function runDone({ delivery, footerHint, numbers }) {
  return applyToMatched({
    delivery, footerHint, numbers,
    mutate: store.markDone,
    confirm: (refs) => `✅ Marked ${refs} as done.`,
  });
}

export function runSnooze({ delivery, footerHint, numbers }) {
  return applyToMatched({
    delivery, footerHint, numbers,
    mutate: (state, ids) => store.snooze(state, ids, config.snoozeHours),
    confirm: (refs) => `😴 Snoozed ${refs} for ${config.snoozeHours}h.`,
  });
}
