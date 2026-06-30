import { searchMessages, getChatName, getReactedMessageIds, listThreadMessages } from './lark.js';
import { config, isExcludedChatName } from './config.js';
import { hiddenMessageIds } from './state.js';
import { MS_PER_DAY } from './time.js';

/** Parse Lark's "YYYY-MM-DD HH:MM" local-time string into a Date. */
function parseCreateTime(s) {
  if (!s) return null;
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Lark renders non-text content as placeholders inside `content`
 * (e.g. "[Sticker]", "[Image: img_xxx]"). A message with nothing but
 * placeholders carries no human-actionable text and is excluded.
 */
export function hasMeaningfulText(text) {
  const stripped = (text || '')
    .replace(/\[Sticker\]/gi, '')
    .replace(/\[Image:[^\]]*\]/gi, '')
    .replace(/\[(File|Video|Audio|Post|Card):[^\]]*\]/gi, '')
    .trim();
  return stripped.length > 0;
}

// Sender types that are automated noise (release bots, alert apps, etc.).
// `--exclude-sender-type bot` drops only `bot`; `app` senders slip through the
// API filter, so we also drop them here.
const AUTOMATED_SENDER_TYPES = new Set(['bot', 'app']);

/**
 * Does this message @mention the user *directly* (by name)? `--is-at-me` also
 * returns @all broadcasts (Lark counts @all as "at me"), but only a direct
 * mention carries my open_id in the structured `mentions[]`. An @all renders
 * only as `@all`/`@_all` text and never lists my id — so a group message where
 * my id is absent is a broadcast, not a personal ping. See SPEC.md.
 */
export function mentionsUser(mentions, selfOpenId) {
  return (mentions || []).some((m) => m.id === selfOpenId);
}

/**
 * The deep link for the Jump button. Lark gives every message a
 * `message_app_link`, but for THREAD messages that link is a malformed
 * `/client/thread/open` URL — duplicated, snake/lower-cased params (`open_chat_id`,
 * `openchatid`, `open_thread_id`, …) that Lark's own client can't parse, so the
 * button is dead. Non-thread messages get a `/client/chat/open?openChatId=…&position=…`
 * link that works and carries NO token, so for thread messages we rebuild that
 * working form from the message's own chat_id (+ position when it's a real
 * main-timeline sequence; pure in-thread replies report the "-3" sentinel, so we
 * omit it and the button just opens the chat). See SPEC.md "Lark API limitations".
 */
export function jumpLink(msg) {
  const original = msg.message_app_link || null;
  if (!msg.thread_id || !msg.chat_id) return original; // non-thread link already works
  const host = (/^https?:\/\/[^/]+/.exec(original || '') || [])[0] || 'https://applink.larksuite.com';
  const pos = parseInt(msg.message_position, 10);
  const posParam = pos > 0 ? `&position=${pos}` : '';
  return `${host}/client/chat/open?openChatId=${encodeURIComponent(msg.chat_id)}${posParam}`;
}

/**
 * Parse a Lark `message_position` / `thread_message_position` into a comparable
 * integer, or `null` when it carries no real position.
 *
 * Lark message positions are **0-indexed** — the first message in a chat is `"0"`,
 * a genuine value that must compare normally (a reply at position 1 reads it). So
 * we must NOT collapse a real `0` into the same bucket as "missing". Uncomparable
 * cases — which return `null` — are the `-3` thread sentinel (a pure in-thread
 * reply has no main-timeline position) and an absent/garbage value. See SPEC.md.
 */
export function parsePosition(raw) {
  const n = parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? null : n;
}

/**
 * Cache key for a thread row's summary (R2 token guard — see SPEC R2 pre-launch
 * gate + state.getCachedSummary). Three inputs fully determine the bundle we'd send
 * Claude, so they fully determine the answer:
 *   - `threadId`           — which thread,
 *   - `newestPos`          — the thread's newest message position; a new message
 *                            bumps it ⇒ key changes ⇒ re-summarise (the bundle grew),
 *   - `threadWatermark`    — my latest reply position in the thread; if I reply, the
 *                            unread tail + "what I must do" shift ⇒ re-summarise.
 * Returns null (⇒ not cacheable) when there's no thread id or no comparable newest
 * position. The key is per-user because `threadWatermark` is mine and the summary is
 * framed around what *I* must do.
 */
export function threadCacheKey(threadId, newestPos, threadWatermark) {
  if (!threadId || newestPos == null) return null;
  return `${threadId}|${newestPos}|${threadWatermark ?? 'none'}`;
}

function normalize(msg, { isDM, selfOpenId }) {
  const text = (msg.content || '').trim();
  return {
    messageId: msg.message_id,
    chatId: msg.chat_id,
    // Per-chat monotonic sequence — the MAIN-timeline axis of the watermark test.
    // `null` = no comparable main position (the "-3" sentinel or missing); a real
    // `0` is kept as 0 (positions are 0-indexed). See parsePosition + isUnread.
    position: parsePosition(msg.message_position),
    // Thread axis (R4). A thread/topic message also carries a `thread_id` and a
    // per-thread monotonic `thread_message_position`. A pure in-thread reply has a
    // real thread position but `message_position = "-3"`, so isUnread() scopes its
    // read-ness to the per-thread watermark instead of the per-chat one. null = absent.
    threadId: msg.thread_id || null,
    threadPosition: parsePosition(msg.thread_message_position),
    chatName: null, // resolved later, best-effort
    isDM,
    // @all broadcast (group message that didn't name me directly). Kept, but
    // labelled and down-ranked downstream. DMs are never broadcasts.
    isBroadcast: !isDM && !mentionsUser(msg.mentions, selfOpenId),
    senderId: msg.sender?.id || null,
    senderName: msg.sender?.name || msg.sender?.id || 'Someone',
    senderType: msg.sender?.sender_type || null,
    text,
    createTime: parseCreateTime(msg.create_time),
    // Deep link for the Jump button. Verbatim for non-thread messages; rebuilt
    // for thread messages whose `message_app_link` is a broken thread/open URL.
    link: jumpLink(msg),
    deleted: !!msg.deleted,
  };
}

/**
 * Unread (reply-watermark) test. A message lives on exactly one timeline, and the
 * user has "read" it only if they posted at/after it ON THAT timeline. `watermark`
 * carries both axes: `{ chat: Map<chatId,pos>, thread: Map<threadId,threadPos> }`.
 *
 * - **Thread message with a real thread position** (the common case — pure
 *   in-thread replies arrive with `message_position = -3`): scope read-ness to the
 *   THREAD watermark, ignoring the chat watermark. This fixes R4 in both
 *   directions — an in-thread reply now clears the mention, and posting elsewhere
 *   in the same chat no longer clears a thread the user never engaged.
 * - **Everything else** (non-thread messages, and thread messages mirrored to the
 *   main timeline with a real `message_position`): the per-chat watermark, as before.
 * - **Both positions sentinel** (rare): uncomparable on either axis ⇒ unread; it
 *   surfaces once and is clearable with `done`.
 *
 * No watermark on the relevant axis (the user never posted there in the lookback)
 * ⇒ treat as unread. Lark exposes no real read-state, so this is the proxy — see SPEC.md.
 */
export function isUnread(item, watermark) {
  // Thread axis: the message lives in a thread and carries a real per-thread
  // position — compare only against my latest reply in THAT thread.
  if (item.threadId && item.threadPosition != null) {
    const ownThread = watermark.thread.get(item.threadId);
    if (ownThread == null) return true; // never engaged this thread ⇒ unread
    return item.threadPosition > ownThread;
  }
  // Main axis: non-thread messages + thread messages mirrored to main.
  // position == null ⇒ no comparable main position (the "-3" sentinel or missing);
  // ownChat == null ⇒ I never posted in this chat — both ⇒ treat as unread.
  // NB: position 0 is REAL (Lark positions are 0-indexed) and compares normally —
  // a first message I replied to (watermark ≥ 1) must clear, not stick forever.
  const ownChat = watermark.chat.get(item.chatId);
  if (item.position == null || ownChat == null) return true;
  return item.position > ownChat;
}

/**
 * The grouping unit for a digest row (R6). Today a chat collapsed to one row; now
 * the unit depends on the surface, because that's how the work actually clusters:
 *   - **DM**            → one row per conversation (`dm`); bundle = its unread run.
 *   - **@all broadcast** → one row per chat (`single`); never bundled (it's not a
 *                          personal, multi-message ask — see SPEC). DMs aside, this
 *                          is checked before threads so a thread-rooted @all stays single.
 *   - **threaded @me**   → one row per THREAD (`thread`); bundle = a salient slice of
 *                          the thread. In groups, topics live in separate threads, so
 *                          two threads in one chat are usually unrelated.
 *   - **plain group @me** → one row per chat's main timeline (`single`), as before.
 */
export function bundleKey(item) {
  if (item.isDM) return { key: `dm:${item.chatId}`, type: 'dm' };
  if (item.isBroadcast) return { key: `chat:${item.chatId}`, type: 'single' };
  if (item.threadId) return { key: `thread:${item.threadId}`, type: 'thread' };
  return { key: `chat:${item.chatId}`, type: 'single' };
}

/** Latest of a set — newest create_time, tie-broken by higher position. */
function pickLatest(members) {
  return members.reduce((rep, it) => {
    const newer = (it.createTime?.getTime() || 0) - (rep.createTime?.getTime() || 0);
    return newer > 0 || (newer === 0 && (it.position ?? -1) > (rep.position ?? -1)) ? it : rep;
  });
}

/**
 * Group the filtered unread items into rows (replaces the old per-chat collapse).
 * Each row carries the representative (the latest message — it supplies the card's
 * verbatim line + jump link), the `bundleType`, the `members` (all unread items in
 * that group — used to build the bundle, then dropped), and `chatUnreadCount` (the
 * "+N more" count; refined to the thread's unread total once a thread is fetched).
 */
export function groupRows(items) {
  const byKey = new Map();
  for (const it of items) {
    const { key, type } = bundleKey(it);
    let g = byKey.get(key);
    if (!g) { g = { type, members: [] }; byKey.set(key, g); }
    g.members.push(it);
  }
  return [...byKey.values()].map(({ type, members }) => ({
    ...pickLatest(members),
    bundleType: type,
    members,
    chatUnreadCount: members.length,
  }));
}

/** Truncate a single message's text for inclusion in a bundle. */
function clip(text, max) {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/**
 * A DM's unread-run bundle: the unread incoming messages (we already fetched the
 * whole p2p conversation, so no extra call), oldest→newest, recency-capped. All are
 * "from them" — by definition the run is everything after my last sent message.
 */
export function dmBundle(members, { maxMsgs, msgChars }) {
  return [...members]
    .sort((a, b) => (a.createTime?.getTime() || 0) - (b.createTime?.getTime() || 0) || (a.position ?? 0) - (b.position ?? 0))
    .slice(-maxMsgs)
    .map((m) => ({ sender: m.senderName, text: clip(m.text, msgChars), you: false }));
}

/**
 * Pure: pick the SALIENT SLICE of a thread to summarise, so token cost stays ~flat
 * regardless of thread length (the ballooning fix). Keep the union of:
 *   - **head** — first `headMsgs` messages (what the thread is about),
 *   - **mention neighbourhood** — ±`around` messages around each of my @-lines,
 *   - **unread tail** — messages past my per-thread watermark (what's new since I looked).
 * Then cap to `maxMsgs` keeping the head + the most-recent rest (recency-biased), and
 * mark dropped gaps with an `{ elided: n }` sentinel so the summary knows it's not
 * contiguous. `messages` are normalized thread messages; returns slice entries in
 * chronological order (message objects interleaved with elision sentinels).
 */
export function buildThreadSlice(messages, { mentionIds, threadWatermark, headMsgs, around, maxMsgs }) {
  const sorted = messages
    .filter((m) => !m.deleted && hasMeaningfulText(m.text))
    .sort((a, b) =>
      (a.threadPosition ?? a.position ?? 0) - (b.threadPosition ?? b.position ?? 0) ||
      (a.createTime?.getTime() || 0) - (b.createTime?.getTime() || 0));
  if (sorted.length === 0) return [];

  const keep = new Set();
  for (let i = 0; i < Math.min(headMsgs, sorted.length); i++) keep.add(i);
  sorted.forEach((m, i) => {
    // Unread tail: no watermark on this thread ⇒ everything is "new"; the cap bounds it.
    if (threadWatermark == null || (m.threadPosition != null && m.threadPosition > threadWatermark)) keep.add(i);
    if (mentionIds.has(m.messageId)) {
      for (let j = Math.max(0, i - around); j <= Math.min(sorted.length - 1, i + around); j++) keep.add(j);
    }
  });

  let idxs = [...keep].sort((a, b) => a - b);
  if (idxs.length > maxMsgs) {
    const head = idxs.filter((i) => i < headMsgs);
    const rest = idxs.filter((i) => i >= headMsgs).slice(-(maxMsgs - head.length));
    idxs = [...head, ...rest].sort((a, b) => a - b);
  }

  const out = [];
  let prev = -1;
  for (const i of idxs) {
    if (prev !== -1 && i > prev + 1) out.push({ elided: i - prev - 1 });
    out.push(sorted[i]);
    prev = i;
  }
  return out;
}

/**
 * Build a thread row's bundle: gate → fetch → slice → shape for the classifier.
 * Mutates the row's `chatUnreadCount` to the thread's unread total and sets a short
 * `threadTopic` (from the head) so two threads in one chat are distinguishable on the
 * card. Returns the bundle array, or `null` to fall back to a single-message summary
 * (gated out, fetch failed/empty, or nothing salient).
 */
async function buildThreadBundle(row, watermark, self) {
  // Fetch-on-demand gate: a lone, self-contained @-line needs no thread context.
  const lone = row.members.length < 2;
  if (lone && config.threadGateChars > 0 && (row.text || '').length >= config.threadGateChars) return null;

  const raw = await listThreadMessages(row.threadId, { sort: 'desc', pageSize: config.threadFetchPageSize });
  if (raw.length === 0) return null;
  const msgs = raw.map((m) => normalize(m, { isDM: false, selfOpenId: self.openId }));

  const threadWatermark = watermark.thread.get(row.threadId);
  const unreadCount = msgs.filter(
    (m) => threadWatermark == null || (m.threadPosition != null && m.threadPosition > threadWatermark),
  ).length;
  if (unreadCount > 0) row.chatUnreadCount = unreadCount;

  const slice = buildThreadSlice(msgs, {
    mentionIds: new Set(row.members.map((m) => m.messageId)),
    threadWatermark,
    headMsgs: config.threadHeadMsgs,
    around: config.threadAroundMention,
    maxMsgs: config.threadBundleMaxMsgs,
  });
  if (slice.length <= 1) return null; // nothing more than the single message we already have

  const head = slice.find((e) => !e.elided);
  if (head) row.threadTopic = clip(head.text, 32);

  // Stamp the row with its summary-cache key (R2 token guard): the thread's newest
  // position (across ALL fetched messages, not just my mentions) + my thread
  // watermark. Computed from the same fetch that detects "unchanged" — token-free.
  const positions = msgs
    .map((m) => (m.threadPosition != null ? m.threadPosition : m.position))
    .filter((p) => p != null);
  const newestThreadPos = positions.length ? Math.max(...positions) : null;
  row.cacheKey = threadCacheKey(row.threadId, newestThreadPos, threadWatermark);

  return slice.map((e) =>
    e.elided
      ? { sender: '', text: `…(${e.elided} earlier message${e.elided === 1 ? '' : 's'} omitted)…`, you: false }
      : { sender: e.senderName, text: clip(e.text, config.bundleMsgChars), you: e.senderId === self.openId });
}

/**
 * Attach a `bundle` to each row for multi-message summarisation (R6). DMs bundle
 * their already-fetched unread run; threaded group @s fetch a salient thread slice
 * (concurrently, gated); plain group @s and @all broadcasts stay single-message
 * (`bundle` stays undefined ⇒ the classifier summarises the one rep message). The
 * heavy `members` array is dropped afterwards so it never reaches state/card.
 */
async function attachBundles(rows, watermark, self) {
  await Promise.all(rows.map(async (row) => {
    if (row.bundleType === 'dm' && row.members.length > 1) {
      row.bundle = dmBundle(row.members, { maxMsgs: config.dmBundleMaxMsgs, msgChars: config.bundleMsgChars });
    } else if (row.bundleType === 'thread') {
      const bundle = await buildThreadBundle(row, watermark, self);
      if (bundle) row.bundle = bundle;
    }
    delete row.members;
  }));
  return rows;
}

/**
 * Build the reply watermark from the user's OWN recent messages, on BOTH axes:
 *   - `chat`:   chat_id   -> highest main-timeline `message_position`
 *   - `thread`: thread_id -> highest `thread_message_position`
 * isUnread() picks the axis a candidate actually lives on. A message I sent into a
 * thread raises the thread watermark (its `message_position` is the "-3" sentinel,
 * so it never raised the chat watermark — that was the R4 bug). Lark exposes no
 * real read-state, so this is the proxy — see SPEC.md.
 */
async function buildWatermark(self) {
  const start = new Date(Date.now() - config.watermarkLookbackDays * MS_PER_DAY).toISOString();
  const mine = await searchMessages({ sender: self.openId, start });
  const chat = new Map();
  const thread = new Map();
  for (const m of mine) {
    // `?? -1` so a legitimate position 0 (a chat's first message) is still recorded
    // as the watermark rather than dropped (0 > 0 would be false). See parsePosition.
    const pos = parsePosition(m.message_position);
    if (pos != null && pos > (chat.get(m.chat_id) ?? -1)) chat.set(m.chat_id, pos);
    const tpos = parsePosition(m.thread_message_position);
    if (m.thread_id && tpos != null && tpos > (thread.get(m.thread_id) ?? -1)) thread.set(m.thread_id, tpos);
  }
  return { chat, thread };
}

/**
 * Fetch UNREAD @mentions (group chats) and UNREAD DMs (p2p) addressed to the
 * user since `startISO`, normalized, filtered, and collapsed to one row per chat
 * (latest unread). "Unread" = not yet replied to (reply-watermark proxy; Lark has
 * no real read-state — see SPEC.md).
 *
 * Returns { items, skipped: { read, reacted, hidden, automated, excludedChat, empty, capped } }.
 */
export async function fetchSince(startISO, self, state) {
  const [mentionRaw, dmRaw, watermark] = await Promise.all([
    searchMessages({ isAtMe: true, chatType: 'group', start: startISO, excludeSenderType: 'bot' }),
    searchMessages({ chatType: 'p2p', start: startISO, excludeSenderType: 'bot' }),
    buildWatermark(self),
  ]);

  const mentions = mentionRaw.map((m) => normalize(m, { isDM: false, selfOpenId: self.openId }));
  // In p2p, keep only messages sent *to* me (not my own outbound messages).
  const dms = dmRaw
    .filter((m) => m.sender?.id && m.sender.id !== self.openId)
    .map((m) => normalize(m, { isDM: true, selfOpenId: self.openId }));

  // Merge + dedupe by message_id.
  const byId = new Map();
  for (const it of [...mentions, ...dms]) {
    if (!byId.has(it.messageId)) byId.set(it.messageId, it);
  }
  let items = [...byId.values()];

  const hidden = hiddenMessageIds(state);
  const skipped = { read: 0, reacted: 0, hidden: 0, automated: 0, excludedChat: 0, empty: 0, capped: 0 };

  // Unread filter (reply-watermark) — applies to BOTH mentions and DMs.
  items = items.filter((it) => {
    if (!isUnread(it, watermark)) { skipped.read++; return false; }
    return true;
  });

  // Drop automated senders (bots + apps: release cards, alert apps, …).
  items = items.filter((it) => {
    if (AUTOMATED_SENDER_TYPES.has(it.senderType)) { skipped.automated++; return false; }
    return true;
  });

  // Drop done/snoozed, deleted, and empty messages.
  items = items.filter((it) => {
    if (hidden.has(it.messageId)) { skipped.hidden++; return false; }
    if (it.deleted || !hasMeaningfulText(it.text)) { skipped.empty++; return false; }
    return true;
  });

  // Best-effort chat-name resolution. For DMs the "chat name" is the sender.
  // For groups we try chats.get (needs bot capability); null is fine.
  const groupChatIds = [...new Set(items.filter((it) => !it.isDM).map((it) => it.chatId))];
  const nameByChat = new Map();
  await Promise.all(
    groupChatIds.map(async (cid) => nameByChat.set(cid, await getChatName(cid))),
  );
  for (const it of items) {
    it.chatName = it.isDM ? it.senderName : nameByChat.get(it.chatId) || null;
  }

  // Apply name-based noise exclusion where a name is available.
  items = items.filter((it) => {
    if (isExcludedChatName(it.chatName)) { skipped.excludedChat++; return false; }
    return true;
  });

  // Reaction = "addressed": drop messages I've reacted to (same family as the
  // reply-watermark, but per-message). Done here on the smallest candidate set
  // (post local + name filters) and BEFORE the per-chat collapse, so reacting to
  // a chat's latest message lets the row fall back to the next unaddressed one
  // rather than dropping the whole chat. See SPEC.md.
  const reactedIds = await getReactedMessageIds(items.map((it) => it.messageId), self.openId);
  items = items.filter((it) => {
    if (reactedIds.has(it.messageId)) { skipped.reacted++; return false; }
    return true;
  });

  // Group into rows: one per DM, one per thread (threaded @s), one per chat
  // otherwise (R6 — supersedes the flat per-chat collapse).
  let rows = groupRows(items);

  // Newest first; the digest re-sorts by urgency after classification.
  rows.sort((a, b) => (b.createTime?.getTime() || 0) - (a.createTime?.getTime() || 0));

  // Rate-limit guard: cap and report. Done BEFORE bundling so we never spend a
  // thread fetch on a row we're about to drop.
  if (rows.length > config.maxMessages) {
    skipped.capped = rows.length - config.maxMessages;
    rows = rows.slice(0, config.maxMessages);
  }

  // Attach the multi-message bundle to each surviving row (thread fetches run here).
  await attachBundles(rows, watermark, self);

  return { items: rows, skipped };
}
