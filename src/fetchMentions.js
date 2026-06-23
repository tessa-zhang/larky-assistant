import { searchMessages, getChatName, getReactedMessageIds } from './lark.js';
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

function normalize(msg, { isDM, selfOpenId }) {
  const text = (msg.content || '').trim();
  return {
    messageId: msg.message_id,
    chatId: msg.chat_id,
    // Per-chat monotonic sequence — the MAIN-timeline axis of the watermark test.
    // Thread/topic replies come back as the sentinel "-3" (not a real position);
    // normalize keeps it as-is and isUnread() treats any non-positive value as
    // "uncomparable on the main axis".
    position: parseInt(msg.message_position, 10) || 0,
    // Thread axis (R4). A thread/topic message also carries a `thread_id` and a
    // per-thread monotonic `thread_message_position`. A pure in-thread reply has
    // a real thread position but `message_position = -3`, so isUnread() scopes its
    // read-ness to the per-thread watermark instead of the per-chat one. 0 = absent.
    threadId: msg.thread_id || null,
    threadPosition: parseInt(msg.thread_message_position, 10) || 0,
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
  if (item.threadId && item.threadPosition > 0) {
    const ownThread = watermark.thread.get(item.threadId) || 0;
    if (!ownThread) return true; // never engaged this thread ⇒ unread
    return item.threadPosition > ownThread;
  }
  // Main axis: non-thread messages + thread messages mirrored to main.
  const ownChat = watermark.chat.get(item.chatId) || 0;
  // position <= 0 means no comparable main position (the "-3" sentinel with no
  // real thread position either), and no watermark means I never posted in that
  // chat — both ⇒ treat as unread.
  if (item.position <= 0 || !ownChat) return true;
  return item.position > ownChat;
}

/**
 * Collapse to ONE row per chat — the latest unread message — mirroring Lark's
 * "@ Mentions" tab (one entry per conversation). The representative carries
 * `chatUnreadCount` so the card can show "+N more in chat".
 */
export function dedupeByChat(items) {
  const byChat = new Map();
  for (const it of items) {
    const cur = byChat.get(it.chatId);
    if (!cur) { byChat.set(it.chatId, { rep: it, count: 1 }); continue; }
    cur.count++;
    const newer = (it.createTime?.getTime() || 0) - (cur.rep.createTime?.getTime() || 0);
    if (newer > 0 || (newer === 0 && it.position > cur.rep.position)) cur.rep = it;
  }
  return [...byChat.values()].map(({ rep, count }) => ({ ...rep, chatUnreadCount: count }));
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
    const pos = parseInt(m.message_position, 10) || 0;
    if (pos > (chat.get(m.chat_id) || 0)) chat.set(m.chat_id, pos);
    const tpos = parseInt(m.thread_message_position, 10) || 0;
    if (m.thread_id && tpos > (thread.get(m.thread_id) || 0)) thread.set(m.thread_id, tpos);
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

  // One row per chat (latest unread) — matches Lark's "@ Mentions" tab.
  items = dedupeByChat(items);

  // Newest first; the digest re-sorts by urgency after classification.
  items.sort((a, b) => (b.createTime?.getTime() || 0) - (a.createTime?.getTime() || 0));

  // Rate-limit guard: cap and report (caps chats now, post-dedup).
  if (items.length > config.maxMessages) {
    skipped.capped = items.length - config.maxMessages;
    items = items.slice(0, config.maxMessages);
  }

  return { items, skipped };
}
