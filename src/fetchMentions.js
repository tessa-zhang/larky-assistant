import { searchMessages, getChatName } from './lark.js';
import { config, isExcludedChatName } from './config.js';
import { hiddenMessageIds } from './state.js';

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
function hasMeaningfulText(text) {
  const stripped = (text || '')
    .replace(/\[Sticker\]/gi, '')
    .replace(/\[Image:[^\]]*\]/gi, '')
    .replace(/\[(File|Video|Audio|Post|Card):[^\]]*\]/gi, '')
    .trim();
  return stripped.length > 0;
}

function normalize(msg, { isDM }) {
  const text = (msg.content || '').trim();
  return {
    messageId: msg.message_id,
    chatId: msg.chat_id,
    // Per-chat monotonic sequence — used for the unread (reply-watermark) test.
    position: parseInt(msg.message_position, 10) || 0,
    chatName: null, // resolved later, best-effort
    isDM,
    senderId: msg.sender?.id || null,
    senderName: msg.sender?.name || msg.sender?.id || 'Someone',
    senderType: msg.sender?.sender_type || 'user',
    text,
    createTime: parseCreateTime(msg.create_time),
    createTimeRaw: msg.create_time || null,
    // Lark gives us a real, working deep link per message — prefer it over
    // hand-constructing an applink.
    link: msg.message_app_link || null,
    msgType: msg.msg_type,
    deleted: !!msg.deleted,
  };
}

/**
 * Build the reply watermark: chat_id -> highest message_position among the
 * user's OWN recent messages. A candidate is "unread" only if its position is
 * greater than its chat's watermark (i.e. the user has not posted after it).
 * Lark exposes no real read-state, so this is the proxy — see SPEC.md.
 */
async function buildWatermark(self) {
  const start = new Date(Date.now() - config.watermarkLookbackDays * 864e5).toISOString();
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
 * user since `startISO`, normalized and filtered. "Unread" = not yet replied to
 * (reply-watermark proxy; Lark has no real read-state — see SPEC.md).
 *
 * Returns { items, skipped: { read, hidden, excludedChat, empty, capped } }.
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
  const skipped = { read: 0, hidden: 0, excludedChat: 0, empty: 0, capped: 0 };

  // Unread filter (reply-watermark): drop anything at/before my latest message
  // in that chat. Applies to BOTH mentions and DMs.
  items = items.filter((it) => {
    const wm = watermark.get(it.chatId) || 0;
    if (it.position && wm && it.position <= wm) { skipped.read++; return false; }
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

  // Newest first; the digest re-sorts by urgency after classification.
  items.sort((a, b) => (b.createTime?.getTime() || 0) - (a.createTime?.getTime() || 0));

  // Rate-limit guard: cap and report.
  if (items.length > config.maxMessages) {
    skipped.capped = items.length - config.maxMessages;
    items = items.slice(0, config.maxMessages);
  }

  return { items, skipped };
}
