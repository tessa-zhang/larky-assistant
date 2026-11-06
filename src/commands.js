import { config, URGENCY_ORDER } from './config.js';
import { sendMessage } from './lark.js';
import { buildDigestCard, buildFallbackDigestCard } from './buildCard.js';
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

/**
 * Degraded-card order: DMs first, then @ mentions; newest first within each
 * surface. No urgency field participates because fallback means it was not judged.
 */
export function numberFallbackItems(items) {
  items.sort((a, b) => {
    const surface = Number(a.isDM ? 0 : 1) - Number(b.isDM ? 0 : 1);
    if (surface !== 0) return surface;
    return (b.createTime?.getTime?.() || 0) - (a.createTime?.getTime?.() || 0);
  });
  items.forEach((item, index) => { item.n = index + 1; });
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

const digestServices = { store, fetchSince, classify, deliver, now: () => new Date() };
const MORNING_RETRY_MS = 5 * 60_000;

/**
 * Full digest run: fetch → classify → card. Persists lastRunAt + a snapshot of
 * the delivered items so done/snooze can act without re-fetching.
 */
export async function runDigest({
  self,
  delivery,
  footerHint,
  ack = false,
  requireChange = false,
  morningDigestDate = null,
}, services = digestServices) {
  // Injectable boundaries keep pipeline regressions offline (no Lark, model, or Keychain access).
  const { store, fetchSince, classify, deliver, now } = { ...digestServices, ...services };
  const state = store.clearExpiredSnoozes(await store.load(self.openId));
  const runAt = now();
  // Older versions marked even a fallback as complete. Permit those snapshots
  // to recover too, while retaining deduplication for healthy/empty mornings.
  const legacyMorningFallback = state.lastMorningDigestDate === morningDigestDate
    && !state.lastMorningDigestAttemptAt
    && state.lastDigest?.cardMode === 'fallback';
  if (morningDigestDate && state.lastMorningDigestDate === morningDigestDate && !legacyMorningFallback) {
    return {
      count: state.lastDigest?.items?.length || 0,
      sent: false,
      reason: 'already-sent',
      skipped: {},
    };
  }
  if (morningDigestDate && runAt - new Date(state.lastMorningDigestAttemptAt || 0) < MORNING_RETRY_MS) {
    return { count: state.lastDigest?.items?.length || 0, sent: false, reason: 'retry-later', skipped: {} };
  }
  const since = startWindow();
  const sinceDate = new Date(since); // fixed lookback window start
  // Strict title boundary: only the actual scheduled morning path supplies a
  // morningDigestDate. Manual `n`, CLI runs, polls, and fallbacks stay standard.
  const resolvedCardVariant = morningDigestDate ? 'morning' : 'standard';

  if (ack) await deliver(delivery, '⏳ Priotising your mentions, give me a moment…');

  const { items, skipped } = await fetchSince(since, self, state);

  // R12 auto-poll change-gate: a scheduled tick only sends when the unread set
  // actually moved since the last check — cheap (post-fetch, pre-classify), so
  // an unchanged backlog costs no Claude tokens and never re-clutters the DM
  // thread with a near-duplicate card. Manual triggers (`n`, npm run inlark)
  // never set requireChange, so a person asking for the digest always gets one.
  const signature = pollSignature(items);
  const samePollSignature = signaturesEqual(signature, state.lastPollSignature);
  if (requireChange && state.lastDigest?.cardMode !== 'fallback'
    && state.lastPollSignature !== null && samePollSignature) {
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
    if (morningDigestDate) state.lastMorningDigestDate = morningDigestDate;
    state.lastDigest = { generatedAt: runAt.toISOString(), since, items: [], cardVariant: resolvedCardVariant };
    await store.save(self.openId, state);
    return { count: 0, skipped };
  }

  // R17 (2026-10-08): the per-thread summary cache was removed. It stored AI-paraphrased
  // thread contents on disk indefinitely (`threadSummaryCache: { urgency, category, summary }`),
  // which was the heaviest data-at-rest surface in the state file. Every run now classifies
  // every unchanged thread again — paid in Anthropic tokens, not in persisted PII. If cost
  // becomes a real pressure, the right next move is encryption-at-rest, not re-adding the
  // cache. Any pre-existing `state.threadSummaryCache` is dropped on next save.
  delete state.threadSummaryCache;
  const classified = await classify(items, { userName: self.userName });
  for (const it of items) {
    const c = classified.get(it.messageId);
    Object.assign(it, c);
  }

  // A partial fallback is still a classification outage from the user's point
  // of view. Mixing real priorities with guessed LOW rows implies confidence we
  // do not have, so one fallback switches the entire card to the transparent,
  // classification-free DM/@-mention layout.
  const cardMode = items.some((item) => item.fallback) ? 'fallback' : 'prioritized';
  const classifiedCount = items.filter((item) => !item.fallback).length;
  console.log(`[digest] <${self.openId}> classification: ${classifiedCount}/${items.length}; ${cardMode}`);

  // A degraded poll must keep reclassifying an unchanged inbox so recovery can
  // replace the fallback, but it should not deliver the same fallback card on
  // every poll slot. A changed unread set can still produce an updated fallback;
  // a recovered classification still sends the prioritized replacement below.
  if (requireChange && cardMode === 'fallback' && state.lastDigest?.cardMode === 'fallback'
    && samePollSignature) {
    state.lastRunAt = runAt.toISOString();
    await store.save(self.openId, state);
    return { count: items.length, sent: false, reason: 'degraded', skipped };
  }

  if (morningDigestDate) {
    state.lastMorningDigestAttemptAt = runAt.toISOString();
    if (cardMode === 'fallback') {
      // Retry within the morning window, but show only the first degraded card.
      // Preserve the delivered number mapping until a healthy replacement sends.
      const fallbackAlreadyDelivered = state.lastMorningFallbackDate === morningDigestDate || legacyMorningFallback;
      if (legacyMorningFallback) state.lastMorningDigestDate = null;
      if (fallbackAlreadyDelivered) {
        state.lastMorningFallbackDate = morningDigestDate;
        await store.save(self.openId, state);
        return { count: items.length, sent: false, reason: 'degraded', skipped };
      }
    }
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
  if (cardMode === 'fallback') numberFallbackItems(items);
  else numberItems(items);

  // Classifier bookkeeping is only needed during this run; drop it before persisting.
  // Everything else stays — state.save encrypts lastDigest at rest (R17, 2026-10-09),
  // so field-level stripping would add no privacy and would risk breaking a renderer
  // field the next person adds without realising it also needs to be preserved here.
  for (const it of items) { delete it.bundle; delete it.cacheKey; delete it.fallback; }

  const buildCard = cardMode === 'fallback' ? buildFallbackDigestCard : buildDigestCard;
  const card = buildCard({
    items,
    since: sinceDate,
    generatedAt: runAt,
    footerHint,
    variant: resolvedCardVariant,
  });
  await deliver(delivery, card, 'interactive');

  state.lastRunAt = runAt.toISOString();
  if (morningDigestDate) {
    if (cardMode === 'fallback') state.lastMorningFallbackDate = morningDigestDate;
    else state.lastMorningDigestDate = morningDigestDate;
  }
  state.lastDigest = {
    generatedAt: runAt.toISOString(),
    since,
    items,
    cardVariant: resolvedCardVariant,
    cardMode,
  };
  await store.save(self.openId, state);
  return { count: items.length, skipped, ...(cardMode === 'fallback' ? { reason: 'degraded' } : {}) };
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
  const cardMode = state.lastDigest?.cardMode || 'prioritized';
  if (cardMode === 'fallback') numberFallbackItems(remaining);
  else numberItems(remaining);
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
  const buildCard = cardMode === 'fallback' ? buildFallbackDigestCard : buildDigestCard;
  const card = buildCard({
    items: remaining,
    since: state.lastDigest.since ? new Date(state.lastDigest.since) : null,
    generatedAt: new Date(),
    footerHint,
    variant: state.lastDigest.cardVariant || 'standard',
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
