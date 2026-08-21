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

// Sender types that are automated (release bots, alert apps, Slack mirrors, and
// workflow/booster apps). Filtered in-code via passesSenderFilter — NOT the API's
// `--exclude-sender-type` flag, which is too blunt: it drops `app` as well as `bot`
// (verified live) and can't inspect mentions[], so it was silently killing real
// direct @me pings from workflow apps. Dropped by default; a bot/app that @mentions
// me directly in a group is rescued. See passesSenderFilter + SPEC.
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
 * Sender-type gate — replaces the API's `--exclude-sender-type` flag on the mention
 * search (that flag drops `app` too and can't inspect mentions[], so it was killing
 * real pings). A human sender always passes. An automated sender (bot/app) passes
 * ONLY when it @mentions me DIRECTLY in a group — `isBroadcast === false` and not a
 * DM: a workflow/booster app naming me is a genuine, actionable ask, mirroring the
 * noise-channel direct-@me carve-out. An automated DM is a notification, not a
 * person, so it drops. See SPEC "Drop automated senders".
 */
export function passesSenderFilter(item) {
  if (!AUTOMATED_SENDER_TYPES.has(item.senderType)) return true;
  return !item.isDM && !item.isBroadcast;
}

/** Is this item's (representative) sender a bot/app, not a human? See AUTOMATED_SENDER_TYPES. */
export function isAutomatedSender(item) {
  return AUTOMATED_SENDER_TYPES.has(item.senderType);
}

/**
 * The deep link for the Jump button. Lark gives every message a
 * `message_app_link`, but for THREAD messages that link is a malformed
 * `/client/thread/open` URL — duplicated, snake/lower-cased params (`open_chat_id`,
 * `openchatid`, `open_thread_id`, …) that Lark's own client can't parse, so the
 * button is dead. Non-thread messages get a `/client/chat/open?openChatId=…&position=…`
 * link that works and carries NO token, so for thread messages we rebuild from the
 * message's own chat_id:
 *   - **Mirrored to main** (real `message_position`): anchor on `&position=…`, exactly
 *     like a non-thread message — exact, verified working.
 *   - **Pure in-thread reply** (the "-3" sentinel — confirmed live to be the common
 *     case; a whole thread can be ALL-sentinel with no main position anywhere): there
 *     is no main-timeline position to anchor on at all, so the rebuilt link just opens
 *     the chat (the "jumps to the group, not the message" report) — the ceiling of
 *     what's reachable here. **Tried and killed live (2026-08):** appending
 *     `&openThreadId=…` (matching the working `openChatId` convention) to see if it'd
 *     land in the thread — confirmed no-op, identical to the bare chat link, so it's
 *     not worth the extra param. `anchorFallback` (buildThreadBundle) still rescues
 *     this with a real position when the bundle's thread fetch turns one up elsewhere
 *     in the SAME thread (a mix of mirrored + pure-in-thread messages) — that path is
 *     real, verified navigation, not a guess.
 * See SPEC.md "Lark API limitations".
 */
export function jumpLink(msg) {
  const original = msg.message_app_link || null;
  if (!msg.thread_id || !msg.chat_id) return original; // non-thread link already works
  const host = (/^https?:\/\/[^/]+/.exec(original || '') || [])[0] || 'https://applink.larksuite.com';
  const pos = parsePosition(msg.message_position);
  const chatUrl = `${host}/client/chat/open?openChatId=${encodeURIComponent(msg.chat_id)}`;
  return pos != null ? `${chatUrl}&position=${pos}` : chatUrl;
}

/**
 * Parse a Lark `message_position` / `thread_message_position` into a comparable
 * integer, or `null` when it carries no real position.
 *
 * Lark message positions are **0-indexed** — the first message in a chat is `"0"`,
 * a genuine value that must compare normally (a reply at position 1 reads it). So
 * we must NOT collapse a real `0` into the same bucket as "missing". Uncomparable
 * cases — which return `null` — are the negative sentinels (`-3` for a pure
 * in-thread reply with no main-timeline position; `-1` also seen on
 * `thread_message_position`) and an absent/garbage value. Any negative → `null`,
 * so the exact sentinel value doesn't matter. See SPEC.md.
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
// Bump when the classifier PROMPT changes: cached summaries store the OLD prompt's
// urgency/category/summary, so a version tag in the key orphans the stale entries
// (they age out via TTL) and the next run re-classifies under the new prompt.
//   v2: urgency reframed to be relative to what the user must do, not topic severity.
//   v3: directedness evidence added (tagged_count / my_tag_position generalising
//       is_broadcast into one spectrum) — v2 verdicts were reached without it.
export const SUMMARY_CACHE_VERSION = 3;
export function threadCacheKey(threadId, newestPos, threadWatermark) {
  if (!threadId || newestPos == null) return null;
  return `v${SUMMARY_CACHE_VERSION}|${threadId}|${newestPos}|${threadWatermark ?? 'none'}`;
}

function normalize(msg, { isDM, selfOpenId }) {
  const text = (msg.content || '').trim();
  const senderType = msg.sender?.sender_type || null;
  // Directedness signals (2026-08-11) — HOW PERSONALLY this message addressed the user,
  // read off the tag list itself. Verified against 14d of live data: Lark returns
  // `mentions[]` in TEXT order and stamps each entry with an explicit ordinal
  // (`key: "@_user_1"`, `"@_user_2"`, …), so tag position is real data, not inferred.
  const tagList = msg.mentions || [];
  const myTagIndex = tagList.findIndex((m) => m.id === selfOpenId);
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
    // @all broadcast (group message that didn't name me directly) — the far end of the
    // directedness spectrum below. Kept, but labelled and down-ranked downstream.
    // DMs are never broadcasts.
    isBroadcast: !isDM && myTagIndex < 0,
    // How many people this message @mentioned in total. Fewer ⇒ more personally
    // addressed; a long tag list usually means a status update / Q&A card / release
    // note where the user is one of many recipients rather than the person being asked.
    taggedCount: tagList.length,
    // The user's 1-based slot in that tag list (null when not directly named, e.g. @all).
    // Being named FIRST can mean the ask is primarily theirs — but it's a WEAK signal:
    // measured on Tessa's real 14d window she sat at position 2 in 47 of 94 direct @s
    // (63% for automated senders), because senders and templates repeat a roster order.
    // Passed to the classifier as evidence to weigh against the sentence, never used as
    // a ranking rule. See SPEC "Directedness".
    myTagPosition: myTagIndex >= 0 ? myTagIndex + 1 : null,
    senderId: msg.sender?.id || null,
    // Automated senders (app/bot) often carry no display name in the payload (just
    // an app_id like `cli_…`) — show a clean 'Bot' label instead of the raw id.
    senderName: msg.sender?.name || (AUTOMATED_SENDER_TYPES.has(senderType) ? 'Bot' : msg.sender?.id) || 'Someone',
    senderType,
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
 * - **Thread ROOT / message mirrored to main** (`threadId` set, NO thread position,
 *   real main position — verified live as the shape an @mention that *starts* a
 *   thread takes): if I've engaged that thread at all (a thread watermark exists),
 *   it's addressed ⇒ read. Without this it fell to the chat axis, which a pure
 *   in-thread reply never raises, so it resurfaced forever despite the reply
 *   (Case B — the "replied-in-thread but never clears" bug). If I *haven't* engaged
 *   the thread, it keeps the main axis so a main-timeline reply still clears it.
 * - **Everything else** (non-thread messages): the per-chat watermark, as before.
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
  // Thread root / mirrored-to-main message (no thread position, but a real main
  // position) in a thread I've engaged: my in-thread reply addresses it, so treat it
  // as read. The chat axis below never would — my reply is a "-3" that doesn't raise
  // the chat watermark — which is why these resurfaced despite the reply (Case B).
  // Guarded to `position != null` so a truly positionless message stays the residual.
  if (item.threadId && item.position != null && watermark.thread.get(item.threadId) != null) return false;
  // Main axis: non-thread messages + thread messages mirrored to main in a thread I
  // haven't engaged (a real main position ⇒ a main-timeline reply legitimately clears it).
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
 * The direct-@me messages in a bundle (excludes @all broadcasts + DM lines),
 * slimmed for the card's per-@ expander — oldest→newest so the list reads in
 * conversation order. Keeps only what the card needs: sender, a bounded raw excerpt
 * (previewText cleans it at render), and the message's own jump link. Drives the
 * "N @you" badge + the expander so a multi-ask thread doesn't hide earlier @s behind
 * the single bundle summary (R6 follow-up).
 */
function atMeMentions(members) {
  return members
    .filter((m) => !m.isDM && !m.isBroadcast)
    .sort((a, b) =>
      (a.createTime?.getTime() || 0) - (b.createTime?.getTime() || 0) ||
      (a.position ?? 0) - (b.position ?? 0))
    .map((m) => ({ sender: m.senderName, text: clip(m.text, 300), link: m.link }));
}

/**
 * The bundle's **strongest directedness** — the most personally-addressed direct @me in
 * it: fewest people tagged, ties broken by the earliest tag position. A thread can hold
 * both a near-1:1 ask and a 28-person blast; the personal ask is the salient fact about
 * how the user was addressed, so the row is described by its most direct mention rather
 * than by an average or by whichever came last. Nulls when nothing in the bundle named
 * the user directly (an @all-only bundle, or a DM — which is 1:1 by construction).
 */
function strongestTag(members) {
  const direct = members.filter((m) => m.myTagPosition != null);
  if (direct.length === 0) return { taggedCount: null, myTagPosition: null };
  const best = direct.reduce((a, b) => {
    if (b.taggedCount !== a.taggedCount) return b.taggedCount < a.taggedCount ? b : a;
    return b.myTagPosition < a.myTagPosition ? b : a;
  });
  return { taggedCount: best.taggedCount, myTagPosition: best.myTagPosition };
}

/**
 * Pick the row's **representative** — the member whose sender, verbatim excerpt, jump
 * link and timestamp the card row shows, and whose `senderType` decides whether the row
 * is filed under 🤖 BOT / APP.
 *
 * Normally that's simply the latest message in the bundle. **But the row must be anchored
 * to whoever actually addressed the user, not to whoever spoke last** (2026-08-11): in a
 * thread where a colleague @mentioned the user and a workflow app @'d later, the latest
 * member is the bot — so the row would be filed under bots, labelled `· bot ·`, and would
 * show the app's routing note in place of the colleague's real ask. A genuine ask would be
 * buried behind an automated one.
 *
 * ⇒ when the latest member is automated but a **human directly @mentioned the user** in
 * the same bundle, anchor to the **latest human direct-@me** instead. Everything
 * downstream (section routing, the `· bot ·` label, the excerpt, the jump target) then
 * follows from one correctly-chosen sender, so `isAutomatedSender(row)` alone is the right
 * question everywhere — no second mechanism to keep in step.
 *
 * Same line as the 2026-07-14 sender-filter and 2026-07-02 noise-channel carve-outs:
 * **a real person naming the user always wins.** The bot's own message is still reachable —
 * it stays in `members` (so it counts toward the bundle summary + unread count) and, when
 * it's a direct @me, gets its own line and jump in the per-@ expander.
 */
function pickRepresentative(members) {
  const latest = pickLatest(members);
  if (!isAutomatedSender(latest)) return latest;
  const humanAtMe = members.filter((m) => !m.isDM && !m.isBroadcast && !isAutomatedSender(m));
  return humanAtMe.length ? pickLatest(humanAtMe) : latest;
}

/**
 * Group the filtered unread items into rows (replaces the old per-chat collapse).
 * Each row carries the representative (see `pickRepresentative` — it supplies the card's
 * sender, verbatim line, jump link and bot-vs-human classification), the `bundleType`,
 * the `members` (all unread items in that group — used to build the bundle, then dropped),
 * and `chatUnreadCount` (the "+N more" count; refined to the thread's unread total once a
 * thread is fetched).
 */
export function groupRows(items) {
  const byKey = new Map();
  for (const it of items) {
    const { key, type } = bundleKey(it);
    let g = byKey.get(key);
    if (!g) { g = { type, members: [] }; byKey.set(key, g); }
    g.members.push(it);
  }
  return [...byKey.values()].map(({ type, members }) => {
    const mentions = atMeMentions(members);
    return {
      ...pickRepresentative(members),
      // Overrides the representative's own tag figures with the bundle's most direct
      // ones — NB this must come after the spread above. Distinct from `mentionCount`:
      // `taggedCount` counts PEOPLE named in one message, `mentionCount` counts @me
      // MESSAGES in the bundle.
      ...strongestTag(members),
      bundleType: type,
      members,
      chatUnreadCount: members.length,
      // `mentionCount` is the count of unreplied *direct @you* messages in the bundle;
      // it stays the @me count even after buildThreadBundle overwrites chatUnreadCount
      // with the thread's TOTAL unread. `mentions` is the slim list for the expander.
      mentions,
      mentionCount: mentions.length,
    };
  });
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
 * Best-effort jump-link rescue for a thread that never touches the main timeline
 * at all — verified live (2026-08) on real threads: one started via "reply in
 * thread" from scratch carries the "-3" sentinel on EVERY message, so there's no
 * `message_position` anywhere to anchor `chat/open` on, and the specific message's
 * own `jumpLink()` falls back to an unverified `openThreadId` param. If the thread
 * we already fetched for the bundle has even ONE message mirrored to main (a real
 * position — some threads are a mix), reuse it as the anchor for anything in the
 * bundle that lacks its own: still the PROVEN `chat/open`+`position` mechanism,
 * just pointed at the nearest working spot instead of the exact message. Zero
 * extra cost (msgs is already fetched); no-op when the link already has a real
 * position of its own.
 */
export function anchorFallback(link, chatId, anchorPos) {
  if (!link || link.includes('&position=')) return link;
  const host = (/^https?:\/\/[^/]+/.exec(link) || [])[0] || 'https://applink.larksuite.com';
  return `${host}/client/chat/open?openChatId=${encodeURIComponent(chatId)}&position=${anchorPos}`;
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

  // Anchor rescue (see anchorFallback) — runs even if we bail out to a single-message
  // summary below, since it only touches row.link / row.mentions, not the bundle.
  const realPositions = msgs.map((m) => m.position).filter((p) => p != null);
  if (realPositions.length > 0) {
    const anchorPos = Math.min(...realPositions);
    row.link = anchorFallback(row.link, row.chatId, anchorPos);
    for (const m of row.mentions || []) m.link = anchorFallback(m.link, row.chatId, anchorPos);
  }

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
    // No `--exclude-sender-type` on the mention search: the flag is too blunt — it
    // drops `app` as well as `bot` (verified) and can't see mentions[], so it was
    // silently killing real direct @me pings from workflow/booster apps. Sender
    // filtering happens in-code below (passesSenderFilter), where a bot/app that
    // names me directly is kept. See SPEC.
    searchMessages({ isAtMe: true, chatType: 'group', start: startISO }),
    // p2p keeps the pre-filter: a DM is never a direct-@me-via-mentions and never a
    // broadcast, so every automated DM is dropped in-code regardless — pre-filtering
    // at the API here is pure fetch-volume savings with no behavioural change.
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

  // Sender filter (now fully in-code — see passesSenderFilter). Automated senders
  // (bot/app) drop by default, EXCEPT a bot/app that @mentions me directly in a
  // group (a workflow/booster app naming me is a real ask, not broadcast noise).
  items = items.filter((it) => {
    if (passesSenderFilter(it)) return true;
    skipped.automated++;
    return false;
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

  // Name-based noise exclusion — but ONLY for broadcasts. A direct @me is a personal
  // ping worth surfacing even in a "noise" channel; the filter is for @all/automation
  // spam, not people naming me. (Dropping direct @s here was hiding real asks — 2026-07-02.)
  items = items.filter((it) => {
    if (isExcludedChatName(it.chatName) && it.isBroadcast) { skipped.excludedChat++; return false; }
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
