import { test } from 'node:test';
import assert from 'node:assert/strict';

import { relativeTime, formatDateTime, formatDate, MS_PER_HOUR } from '../src/time.js';
import { isExcludedChatName, config } from '../src/config.js';
import { hasMeaningfulText, isUnread, groupRows, bundleKey, dmBundle, buildThreadSlice, mentionsUser, jumpLink, parsePosition, threadCacheKey } from '../src/fetchMentions.js';
import { reactedIdsFromDetails } from '../src/lark.js';
import { extractJson } from '../src/classify.js';
import { buildDigestCard, previewText } from '../src/buildCard.js';
import { clearExpiredSnoozes, hiddenMessageIds, markDone, snooze, getCachedSummary, setCachedSummary, pruneSummaryCache } from '../src/state.js';

const NOW = new Date('2026-06-16T12:00:00Z');

test('relativeTime renders each granularity and tolerates null', () => {
  assert.equal(relativeTime(null), '');
  assert.equal(relativeTime(new Date(NOW - 10 * 1000), NOW), 'just now'); // <30s rounds to 0m
  assert.equal(relativeTime(new Date(NOW - 45 * 60 * 1000), NOW), '45m ago');
  assert.equal(relativeTime(new Date(NOW - 2 * MS_PER_HOUR), NOW), '2h ago');
  assert.equal(relativeTime(new Date(NOW - 3 * 24 * MS_PER_HOUR), NOW), '3d ago');
});

test('formatDateTime returns a non-empty human string', () => {
  assert.equal(typeof formatDateTime(NOW), 'string');
  assert.ok(formatDateTime(NOW).length > 0);
});

test('formatDate renders the date without a time component', () => {
  const s = formatDate(NOW);
  assert.ok(s.length > 0);
  assert.ok(!/\d{1,2}:\d{2}/.test(s)); // no HH:MM — time was dropped from the lookback label
});

test('isExcludedChatName matches noise patterns only', () => {
  assert.equal(isExcludedChatName('unbookable-item-alert-sg'), true);
  assert.equal(isExcludedChatName('merchandising_oncall'), true);
  assert.equal(isExcludedChatName('Some Channel | Slack'), false); // Slack-mirror pattern removed 2026-07-02 (real coordination groups)
  assert.equal(isExcludedChatName('TA Demand Engineering'), false);
  assert.equal(isExcludedChatName(null), false);
});

test('hasMeaningfulText ignores placeholder-only content', () => {
  assert.equal(hasMeaningfulText('[Sticker]'), false);
  assert.equal(hasMeaningfulText('[Image: img_123]'), false);
  assert.equal(hasMeaningfulText('  '), false);
  assert.equal(hasMeaningfulText('real question?'), true);
  assert.equal(hasMeaningfulText('see this [Image: img_1] please'), true);
});

test('parsePosition keeps real 0-indexed positions, nulls sentinels and missing', () => {
  assert.equal(parsePosition('0'), 0);       // first message in a chat — a REAL position
  assert.equal(parsePosition('42'), 42);
  assert.equal(parsePosition(7), 7);
  assert.equal(parsePosition('-3'), null);    // pure in-thread reply sentinel
  assert.equal(parsePosition(undefined), null);
  assert.equal(parsePosition(null), null);
  assert.equal(parsePosition(''), null);
  assert.equal(parsePosition('abc'), null);
});

test('isUnread compares on the main axis; position 0 is real, null is uncomparable', () => {
  const watermark = { chat: new Map([['oc_a', 100]]), thread: new Map() };
  assert.equal(isUnread({ chatId: 'oc_a', position: 101 }, watermark), true);  // newer than my reply
  assert.equal(isUnread({ chatId: 'oc_a', position: 100 }, watermark), false); // my reply itself
  assert.equal(isUnread({ chatId: 'oc_a', position: 99 }, watermark), false);  // before my reply
  assert.equal(isUnread({ chatId: 'oc_b', position: 5 }, watermark), true);    // no reply in that chat
  // REGRESSION (Henry/Saddam DMs): a position-0 first message I replied to
  // (watermark 1) must clear — a real 0 is NOT "missing".
  const wm0 = { chat: new Map([['oc_c', 1]]), thread: new Map() };
  assert.equal(isUnread({ chatId: 'oc_c', position: 0 }, wm0), false);          // 0 < my reply 1 ⇒ read
  assert.equal(isUnread({ chatId: 'oc_c', position: 0 }, { chat: new Map(), thread: new Map() }), true); // not replied yet
  // null position = "-3" sentinel / missing ⇒ no comparable position ⇒ unread.
  assert.equal(isUnread({ chatId: 'oc_a', position: null }, watermark), true);
});

test('isUnread scopes thread messages to the per-thread watermark (R4)', () => {
  // I replied in thread omt_1 (up to thread_position 12) but never in omt_2.
  // I also posted recently on oc_a's MAIN timeline (chat watermark 100).
  const watermark = { chat: new Map([['oc_a', 100]]), thread: new Map([['omt_1', 12]]) };
  // Pure in-thread reply: no main position (null), real thread position.
  const threadMsg = (threadPosition, threadId = 'omt_1') =>
    ({ chatId: 'oc_a', position: null, threadId, threadPosition });

  // Bug-fix #1 (false positive): an in-thread reply now clears the mention.
  assert.equal(isUnread(threadMsg(10), watermark), false); // 10 <= my thread reply 12 ⇒ read
  assert.equal(isUnread(threadMsg(12), watermark), false); // my reply itself ⇒ read
  assert.equal(isUnread(threadMsg(13), watermark), true);  // posted after my reply ⇒ unread

  // Bug-fix #2 (false negative): a thread I never engaged stays unread EVEN THOUGH
  // I posted on oc_a's main timeline (chat watermark must be ignored here).
  assert.equal(isUnread(threadMsg(7, 'omt_2'), watermark), true);

  // No real position on either axis (sentinel main + no thread position) ⇒
  // main axis sees a null position ⇒ unread, surfaces once (clearable with done).
  assert.equal(isUnread({ chatId: 'oc_a', position: null, threadId: 'omt_1', threadPosition: null }, watermark), true);

  // A thread message mirrored to main (real message_position, no thread position)
  // still clears via the chat watermark — it's genuinely visible on main.
  assert.equal(isUnread({ chatId: 'oc_a', position: 80, threadId: 'omt_1', threadPosition: null }, watermark), false);
});

test('isUnread (Case B): a thread-root/mirrored @mention clears once I reply IN its thread', () => {
  // Real Lark shape (verified live): an @mention that starts a thread arrives with a real
  // MAIN position but NO thread_message_position (a "mirrored to main" root). Replying to
  // it the natural way — inside the thread — raises only the THREAD watermark. Before this
  // fix, isUnread routed such a message to the chat axis (no thread position), which the
  // in-thread reply never raises, so it resurfaced forever despite the reply.
  const rootMention = { chatId: 'oc_b', position: 76, threadId: 'omt_b', threadPosition: null };

  // I've replied in the thread (thread watermark exists) ⇒ addressed ⇒ read.
  assert.equal(isUnread(rootMention, { chat: new Map(), thread: new Map([['omt_b', 4]]) }), false);
  // I've engaged neither the thread nor the chat's main timeline ⇒ still unread.
  assert.equal(isUnread(rootMention, { chat: new Map(), thread: new Map() }), true);
  // A main-timeline reply past it still clears it too, exactly as before the fix.
  assert.equal(isUnread(rootMention, { chat: new Map([['oc_b', 80]]), thread: new Map() }), false);
  // Guard: a positionless message (no main AND no thread position) in an engaged thread is
  // NOT force-cleared by this branch — it stays the "surfaces once" residual (needs a real
  // main position to be considered genuinely mirrored/visible).
  assert.equal(isUnread({ chatId: 'oc_b', position: null, threadId: 'omt_b', threadPosition: null }, { chat: new Map(), thread: new Map([['omt_b', 4]]) }), true);
});

test('mentionsUser detects a direct @me but not an @all broadcast', () => {
  const me = 'ou_me';
  // Direct mention: my open_id is in the structured mentions[].
  assert.equal(mentionsUser([{ id: 'ou_x', name: 'X' }, { id: me, name: 'Me' }], me), true);
  // @all: renders only as text, my id never appears in mentions[].
  assert.equal(mentionsUser([], me), false);
  assert.equal(mentionsUser([{ id: 'ou_x' }], me), false);
  assert.equal(mentionsUser(undefined, me), false);
});

test('reactedIdsFromDetails returns only messages I reacted to', () => {
  const details = [
    { message_id: 'om_1', message_reaction_items: [{ operator: { operator_id: 'ou_me' } }] },
    { message_id: 'om_2', message_reaction_items: [{ operator: { operator_id: 'ou_other' } }] },
    { message_id: 'om_3', message_reaction_items: [] },
    { message_id: 'om_4', message_reaction_items: [{ operator: { operator_id: 'ou_x' } }, { operator: { operator_id: 'ou_me' } }] },
  ];
  const out = reactedIdsFromDetails(details, 'ou_me');
  assert.deepEqual([...out].sort(), ['om_1', 'om_4']); // mine on 1 and 4; not 2 (other) or 3 (none)
  assert.equal(reactedIdsFromDetails(undefined, 'ou_me').size, 0);
});

test('jumpLink passes through working chat links, rebuilds broken thread links', () => {
  // Non-thread message: Lark's /client/chat/open link works — pass it through verbatim.
  const chatLink = 'https://applink.larksuite.com/client/chat/open?openChatId=oc_a&position=42';
  assert.equal(jumpLink({ chat_id: 'oc_a', message_position: '42', message_app_link: chatLink }), chatLink);

  // Thread message with a real main-timeline position: rebuild as chat/open
  // (the thread/open applink is malformed), reusing the original host, pinpointing via position.
  assert.equal(
    jumpLink({
      chat_id: 'oc_b', thread_id: 'omt_1', message_position: '7',
      message_app_link: 'https://applink.larksuite.com/client/thread/open?open_chat_id=oc_b&open_thread_id=omt_1',
    }),
    'https://applink.larksuite.com/client/chat/open?openChatId=oc_b&position=7',
  );

  // Pure in-thread reply: message_position is the "-3" sentinel → omit position;
  // the rebuilt link just opens the chat (clickable, unlike the dead thread link). Host reused.
  assert.equal(
    jumpLink({
      chat_id: 'oc_c', thread_id: 'omt_2', message_position: '-3', thread_message_position: '10',
      message_app_link: 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_c&open_thread_id=omt_2',
    }),
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_c',
  );
});

test('bundleKey routes by surface: DM, @all (never a thread), thread, plain group', () => {
  assert.deepEqual(bundleKey({ isDM: true, chatId: 'oc_d' }), { key: 'dm:oc_d', type: 'dm' });
  // an @all that happens to sit in a thread is still single — broadcast wins over thread.
  assert.deepEqual(bundleKey({ isDM: false, isBroadcast: true, threadId: 'omt_x', chatId: 'oc_b' }), { key: 'chat:oc_b', type: 'single' });
  assert.deepEqual(bundleKey({ isDM: false, isBroadcast: false, threadId: 'omt_y', chatId: 'oc_c' }), { key: 'thread:omt_y', type: 'thread' });
  assert.deepEqual(bundleKey({ isDM: false, isBroadcast: false, threadId: null, chatId: 'oc_e' }), { key: 'chat:oc_e', type: 'single' });
});

test('groupRows: one row per DM / per thread / per chat-main, latest is rep, count carried', () => {
  const t = (h) => new Date(`2026-06-16T${h}:00:00Z`);
  const items = [
    { isDM: true, chatId: 'oc_dm', messageId: 'd1', position: 1, createTime: t('09') },
    { isDM: true, chatId: 'oc_dm', messageId: 'd2', position: 2, createTime: t('10') }, // latest DM
    { isDM: false, threadId: 'omt_1', chatId: 'oc_g', messageId: 't1', position: null, createTime: t('08') },
    { isDM: false, threadId: 'omt_1', chatId: 'oc_g', messageId: 't2', position: null, createTime: t('11') }, // latest in thread 1
    { isDM: false, threadId: 'omt_2', chatId: 'oc_g', messageId: 't3', position: null, createTime: t('07') }, // separate thread, same chat
    { isDM: false, threadId: null, chatId: 'oc_g', messageId: 'g1', position: 9, createTime: t('06') }, // plain main-timeline @
    { isDM: false, isBroadcast: true, chatId: 'oc_ann', messageId: 'b1', position: 3, createTime: t('05') },
  ];
  const byId = new Map(groupRows(items).map((r) => [r.messageId, r]));
  assert.equal(byId.size, 5); // dm, thread1, thread2, chat-main, broadcast — two threads in oc_g do NOT merge
  assert.equal(byId.get('d2').bundleType, 'dm');
  assert.equal(byId.get('d2').chatUnreadCount, 2);     // d1+d2
  assert.equal(byId.get('t2').bundleType, 'thread');
  assert.equal(byId.get('t2').chatUnreadCount, 2);     // t1+t2 in thread 1
  assert.equal(byId.get('t3').bundleType, 'thread');   // thread 2 is its own row
  assert.equal(byId.get('g1').bundleType, 'single');   // plain main-timeline @
  assert.equal(byId.get('b1').bundleType, 'single');   // @all never bundled
});

test('dmBundle takes the unread run oldest→newest, recency-caps, clips, marks not-me', () => {
  const t = (h) => new Date(`2026-06-16T${h}:00:00Z`);
  const members = [
    { senderName: 'Bob', text: 'third',  createTime: t('11'), position: 3 },
    { senderName: 'Bob', text: 'first',  createTime: t('09'), position: 1 },
    { senderName: 'Bob', text: 'second', createTime: t('10'), position: 2 },
  ];
  const out = dmBundle(members, { maxMsgs: 2, msgChars: 300 });
  assert.deepEqual(out.map((m) => m.text), ['second', 'third']); // sorted, last 2 kept
  assert.ok(out.every((m) => m.you === false && m.sender === 'Bob'));
  // clip collapses whitespace and truncates with an ellipsis
  const clipped = dmBundle([{ senderName: 'X', text: 'a   b ' + 'z'.repeat(40), createTime: t('09'), position: 1 }], { maxMsgs: 5, msgChars: 6 });
  assert.equal(clipped[0].text, 'a b z…');
});

test('buildThreadSlice keeps head + mention window + unread tail in order', () => {
  // positions 0..5, all meaningful; @mention on position 4, my thread watermark at 4.
  const msgs = Array.from({ length: 6 }, (_, i) => ({ messageId: `m${i}`, threadPosition: i, text: `msg ${i}`, deleted: false }));
  const slice = buildThreadSlice(msgs, { mentionIds: new Set(['m4']), threadWatermark: 4, headMsgs: 2, around: 1, maxMsgs: 8 });
  const kept = slice.filter((e) => !e.elided).map((e) => e.threadPosition);
  assert.deepEqual(kept, [0, 1, 3, 4, 5]); // head 0,1 + window 3,4,5 (5 is also unread tail); 2 dropped
  assert.equal(slice.filter((e) => e.elided).length, 1); // one gap (position 2)
  assert.equal(slice.find((e) => e.elided).elided, 1);
});

test('buildThreadSlice caps recency-biased, keeping the head and eliding the middle', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ messageId: `m${i}`, threadPosition: i, text: `msg ${i}`, deleted: false }));
  // no watermark ⇒ every message is "unread"; cap must still bound the slice.
  const slice = buildThreadSlice(msgs, { mentionIds: new Set(), threadWatermark: null, headMsgs: 2, around: 2, maxMsgs: 4 });
  const kept = slice.filter((e) => !e.elided).map((e) => e.threadPosition);
  assert.deepEqual(kept, [0, 1, 8, 9]); // head 0,1 + most-recent 8,9
  assert.equal(slice.find((e) => e.elided).elided, 6); // positions 2..7 elided
});

test('previewText strips markup/placeholders, collapses whitespace, truncates', () => {
  assert.equal(previewText('<p>hi   there</p>'), 'hi there');
  assert.equal(previewText('look [Image: img_1] now'), 'look now');
  assert.equal(previewText('line1\nline2'), 'line1 line2');
  assert.equal(previewText('abcdef', 4), 'abc…');
  assert.equal(previewText(''), '');
});

test('extractJson handles bare, fenced, and prefaced arrays; throws otherwise', () => {
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(extractJson('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJson('Here you go: [1,2,3] — done'), [1, 2, 3]);
  assert.throws(() => extractJson('no array here'));
});

test('snooze hides items, then clearExpiredSnoozes releases the expired ones', () => {
  const state = { doneMessageIds: [], snoozedMessages: [] };
  snooze(state, ['om_1'], 24, NOW);
  assert.equal(hiddenMessageIds(state).has('om_1'), true);

  const afterExpiry = new Date(NOW.getTime() + 25 * MS_PER_HOUR);
  clearExpiredSnoozes(state, afterExpiry);
  assert.equal(hiddenMessageIds(state).has('om_1'), false);
});

test('markDone records ids and un-snoozes them', () => {
  const state = { doneMessageIds: [], snoozedMessages: [] };
  snooze(state, ['om_1'], 24, NOW);
  markDone(state, ['om_1']);
  assert.deepEqual(state.doneMessageIds, ['om_1']);
  assert.equal(state.snoozedMessages.length, 0); // done item no longer snoozed
});

test('buildDigestCard groups by urgency and caps the LOW bucket', () => {
  const lowCount = config.lowDisplayLimit + 2;
  const items = [
    { n: 1, urgency: 'high', category: 'incident', summary: 'prod down', isDM: false, chatName: 'ops', senderName: 'Alice', text: 'checkout is throwing 500s', chatUnreadCount: 3, link: 'https://x', createTime: NOW },
    { n: 2, urgency: 'low', category: 'fyi', summary: 'all-hands reminder', isDM: false, isBroadcast: true, chatName: 'announcements', senderName: 'Carol', text: 'Hi @all standup moved', chatUnreadCount: 1, link: null, createTime: NOW },
    ...Array.from({ length: lowCount }, (_, i) => ({
      n: i + 3, urgency: 'low', category: 'fyi', summary: `chatter ${i}`, isDM: true, chatName: 'Bob', senderName: 'Bob', text: `note ${i}`, chatUnreadCount: 1, link: null, createTime: NOW,
    })),
  ];

  const card = buildDigestCard({ items, since: NOW, generatedAt: NOW, footerHint: 'hint' });

  assert.equal(card.schema, '2.0');             // v2 card (collapsible_panel needs it)
  assert.ok(card.header.title.content.startsWith('📋'));
  const text = JSON.stringify(card.body.elements);
  assert.ok(text.includes('HIGH PRIORITY'));
  assert.ok(text.includes('LOW / FYI'));
  assert.ok(text.includes('more low/FYI'));   // low bucket: only lowDisplayLimit shown, rest summarised
  assert.ok(text.includes('checkout is throwing 500s')); // verbatim message excerpt rendered
  assert.ok(text.includes('Alice'));          // group sender prefixed on the excerpt
  assert.ok(text.includes('📣 @all'));         // broadcast tag rendered on the @all item
  assert.ok(text.includes('hint'));           // footer
});

test('buildDigestCard (R3) collapses ONLY low/FYI behind a panel; high/medium stay flat', () => {
  const items = [
    { n: 1, urgency: 'high', category: 'incident', summary: 'prod down', isDM: false, chatName: 'ops', senderName: 'Alice', text: 'checkout 500s', chatUnreadCount: 1, link: 'https://x', createTime: NOW },
    { n: 2, urgency: 'medium', category: 'review_request', summary: 'review my PRD', isDM: false, chatName: 'eng', senderName: 'Bob', text: 'PTAL', chatUnreadCount: 1, link: 'https://y', createTime: NOW },
    { n: 3, urgency: 'low', category: 'fyi', summary: 'fyi note', isDM: true, chatName: 'Carol', senderName: 'Carol', text: 'just so you know', chatUnreadCount: 1, link: null, createTime: NOW },
  ];
  const top = buildDigestCard({ items, since: NOW, generatedAt: NOW }).body.elements;

  // Exactly one collapsible panel, collapsed, holding the low bucket with its count.
  const panels = top.filter((e) => e.tag === 'collapsible_panel');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].expanded, false);
  assert.ok(panels[0].header.title.content.includes('LOW / FYI'));
  assert.ok(panels[0].header.title.content.includes('(1)'));        // count visible while collapsed
  assert.ok(JSON.stringify(panels[0].elements).includes('fyi note')); // low item lives INSIDE the panel

  // High/medium are NOT inside any panel — they sit flat at the top level.
  const flat = JSON.stringify(top.filter((e) => e.tag !== 'collapsible_panel'));
  assert.ok(flat.includes('prod down'));   // high summary rendered expanded
  assert.ok(flat.includes('review my PRD')); // medium summary rendered expanded
  assert.ok(!flat.includes('fyi note'));     // low summary is NOT at the top level
});

test('buildDigestCard expands LOW/FYI when it is the only bucket (cap still applies)', () => {
  const lowCount = config.lowDisplayLimit + 3;
  const items = Array.from({ length: lowCount }, (_, i) => ({
    n: i + 1, urgency: 'low', category: 'fyi', summary: `chatter ${i}`, isDM: true, chatName: 'Bob', senderName: 'Bob', text: `note ${i}`, chatUnreadCount: 1, link: null, createTime: NOW,
  }));
  const top = buildDigestCard({ items, since: NOW, generatedAt: NOW }).body.elements;

  // No collapse when LOW is the sole bucket — a collapsed lone bucket reads as empty.
  assert.equal(top.filter((e) => e.tag === 'collapsible_panel').length, 0);

  const text = JSON.stringify(top);
  assert.ok(text.includes('LOW / FYI'));      // section title still rendered, flat
  assert.ok(text.includes('chatter 0'));      // low items rendered at top level, expanded
  assert.ok(text.includes('more low/FYI'));   // LOW_DISPLAY_LIMIT cap still guards overflow
});

test('buildDigestCard marks thread rows with a 🧵 and the thread topic', () => {
  const items = [
    { n: 1, urgency: 'medium', category: 'question', summary: 'weigh in on rollout', isDM: false, bundleType: 'thread', threadTopic: 'staged rollout plan', chatName: 'eng', senderName: 'Dana', text: 'thoughts?', chatUnreadCount: 4, link: 'https://x', createTime: NOW },
  ];
  const text = JSON.stringify(buildDigestCard({ items, since: NOW, generatedAt: NOW }).body.elements);
  assert.ok(text.includes('🧵'));                 // thread marker
  assert.ok(text.includes('staged rollout plan')); // topic disambiguates threads in the same chat
  assert.ok(text.includes('+3 more'));            // chatUnreadCount 4 → +3 more
});

// --- R2 token guard: per-thread summary cache --------------------------------

test('threadCacheKey is stable for the same thread state and shifts when it changes', () => {
  const base = threadCacheKey('omt_1', 12, 5);
  assert.equal(base, threadCacheKey('omt_1', 12, 5));        // same inputs → same key (cache hit)
  assert.notEqual(base, threadCacheKey('omt_1', 13, 5));     // new message (newest pos bumps) → miss
  assert.notEqual(base, threadCacheKey('omt_1', 12, 6));     // I replied (watermark moves) → miss
  assert.notEqual(base, threadCacheKey('omt_2', 12, 5));     // different thread → miss
});

test('threadCacheKey returns null (uncacheable) without a thread id or newest position', () => {
  assert.equal(threadCacheKey(null, 5, 1), null);
  assert.equal(threadCacheKey('omt_1', null, 1), null);
  // A never-replied thread (no watermark) is still cacheable — key encodes "none".
  assert.equal(threadCacheKey('omt_1', 5, null), 'omt_1|5|none');
  // Position 0 is a REAL newest position (0-indexed), not "missing" — must cache.
  assert.equal(threadCacheKey('omt_1', 0, 0), 'omt_1|0|0');
});

test('summary cache stores and reuses a classification, refreshing recency on hit', () => {
  const state = { threadSummaryCache: {} };
  const cls = { urgency: 'high', category: 'incident', summary: 'rollback the deploy now' };
  const t0 = new Date('2026-06-20T00:00:00Z');
  setCachedSummary(state, 'k1', cls, t0);

  const hit = getCachedSummary(state, 'k1', NOW);
  assert.deepEqual(hit, cls);                                   // exact classification reused (0 tokens)
  assert.equal(state.threadSummaryCache.k1.savedAt, NOW.toISOString()); // recency refreshed on hit
  assert.equal(getCachedSummary(state, 'missing'), null);       // miss → null → caller classifies
  assert.equal(getCachedSummary(state, null), null);            // uncacheable row → null
});

test('pruneSummaryCache drops orphaned (stale) entries but keeps fresh ones', () => {
  const state = {
    threadSummaryCache: {
      fresh: { urgency: 'low', category: 'fyi', summary: 'x', savedAt: new Date(NOW - 2 * MS_PER_HOUR).toISOString() },
      stale: { urgency: 'low', category: 'fyi', summary: 'y', savedAt: new Date(NOW - 100 * MS_PER_HOUR).toISOString() },
    },
  };
  pruneSummaryCache(state, 24, NOW); // 24h TTL
  assert.ok(state.threadSummaryCache.fresh);   // 2h old → kept
  assert.ok(!state.threadSummaryCache.stale);  // 100h old → orphan aged out
});

test('pruneSummaryCache with ttl<=0 clears the whole cache (kill switch)', () => {
  const state = { threadSummaryCache: { a: { savedAt: NOW.toISOString() } } };
  pruneSummaryCache(state, 0, NOW);
  assert.deepEqual(state.threadSummaryCache, {});
});
