import { searchMessages, getChatName } from './lark.js';
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

function normalize(msg, { isDM }) {
  const text = (msg.content || '').trim();
  return {
    messageId: msg.message_id,
    chatId: msg.chat_id,
    // Per-chat monotonic sequence — used for the unread (reply-watermark) test.
    // Thread/topic replies come back as the sentinel "-3" (not a real position);
    // normalize keeps it as-is and isUnread() treats any non-positive value as
    // "uncomparable ⇒ unread" rather than misreading it as already-read.
    position: parseInt(msg.message_position, 10) || 0,
    chatName: null, // resolved later, best-effort
    isDM,
    senderId: msg.sender?.id || null,
    senderName: msg.sender?.name || msg.sender?.id || 'Someone',
    senderType: msg.sender?.sender_type || null,
    text,
    createTime: parseCreateTime(msg.create_time),
    // Lark gives us a real, working deep link per message — prefer it over
    // hand-constructing an applink.
    link: msg.message_app_link || null,
    deleted: !!msg.deleted,
  };
}

/**
 * Unread (reply-watermark) test: a candidate is unread only if it is newer than
 * the user's own latest message in that chat. No watermark for the chat (the
 * user never posted there in the lookback) ⇒ treat as unread. Lark has no real
 * read-state, so this is the proxy — see SPEC.md.
 */
export function isUnread(item, watermark) {
  const latestOwn = watermark.get(item.chatId) || 0;
  // position <= 0 means no comparable position (e.g. the "-3" thread sentinel),
  // and no watermark means I never posted in that chat — both ⇒ treat as unread.
  if (item.position <= 0 || !latestOwn) return true;
  return item.position > latestOwn;
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
 * Build the reply watermark: chat_id -> highest message_position among the
 * user's OWN recent messages. A candidate is "unread" only if its position is
 * greater than its chat's watermark (i.e. the user has not posted after it).
 * Lark exposes no real read-state, so this is the proxy — see SPEC.md.
 */
async function buildWatermark(self) {
  const start = new Date(Date.now() - config.watermarkLookbackDays * MS_PER_DAY).toISOString();
  const mine = await searchMessages({ sender: self.openId, start });
  const wm = new Map();
  for (const m of mine) {
    const pos = parseInt(m.message_position, 10) || 0;
    if (pos > (wm.get(m.chat_id) || 0)) wm.set(m.chat_id, pos);
  }
  return wm;
}

/**
 * Fetch UNREAD @mentions (group chats) and UNREAD DMs (p2p) addressed to the
 * user since `startISO`, normalized, filtered, and collapsed to one row per chat
 * (latest unread). "Unread" = not yet replied to (reply-watermark proxy; Lark has
 * no real read-state — see SPEC.md).
 *
 * Returns { items, skipped: { read, hidden, automated, excludedChat, empty, capped } }.
 */
export async function fetchSince(startISO, self, state) {
  const [mentionRaw, dmRaw, watermark] = await Promise.all([
    searchMessages({ isAtMe: true, chatType: 'group', start: startISO, excludeSenderType: 'bot' }),
    searchMessages({ chatType: 'p2p', start: startISO, excludeSenderType: 'bot' }),
    buildWatermark(self),
  ]);

  const mentions = mentionRaw.map((m) => normalize(m, { isDM: false }));
  // In p2p, keep only messages sent *to* me (not my own outbound messages).
  const dms = dmRaw
    .filter((m) => m.sender?.id && m.sender.id !== self.openId)
    .map((m) => normalize(m, { isDM: true }));

  // Merge + dedupe by message_id.
  const byId = new Map();
  for (const it of [...mentions, ...dms]) {
    if (!byId.has(it.messageId)) byId.set(it.messageId, it);
  }
  let items = [...byId.values()];

  const hidden = hiddenMessageIds(state);
  const skipped = { read: 0, hidden: 0, automated: 0, excludedChat: 0, empty: 0, capped: 0 };

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
