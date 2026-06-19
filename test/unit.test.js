import { test } from 'node:test';
import assert from 'node:assert/strict';

import { relativeTime, formatDateTime, formatDate, MS_PER_HOUR } from '../src/time.js';
import { isExcludedChatName, config } from '../src/config.js';
import { hasMeaningfulText, isUnread, dedupeByChat, mentionsUser, jumpLink } from '../src/fetchMentions.js';
import { reactedIdsFromDetails } from '../src/lark.js';
import { extractJson } from '../src/classify.js';
import { buildDigestCard, previewText } from '../src/buildCard.js';
import { clearExpiredSnoozes, hiddenMessageIds, markDone, snooze } from '../src/state.js';

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
  assert.equal(isExcludedChatName('Some Channel | Slack'), true);
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

test('isUnread is true only past the chat watermark', () => {
  const watermark = new Map([['oc_a', 100]]);
  assert.equal(isUnread({ chatId: 'oc_a', position: 101 }, watermark), true);  // newer than my reply
  assert.equal(isUnread({ chatId: 'oc_a', position: 100 }, watermark), false); // my reply itself
  assert.equal(isUnread({ chatId: 'oc_a', position: 99 }, watermark), false);  // before my reply
  assert.equal(isUnread({ chatId: 'oc_b', position: 5 }, watermark), true);    // no reply in that chat
  assert.equal(isUnread({ chatId: 'oc_a', position: 0 }, watermark), true);    // unknown position
  // Thread/topic replies arrive as the "-3" sentinel — must NOT be read as
  // already-read just because a watermark exists for the chat (regression).
  assert.equal(isUnread({ chatId: 'oc_a', position: -3 }, watermark), true);
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

test('dedupeByChat keeps the latest message per chat and counts the rest', () => {
  const t = (h) => new Date(`2026-06-16T${h}:00:00Z`);
  const items = [
    { chatId: 'oc_a', messageId: 'm1', position: 10, createTime: t('09') },
    { chatId: 'oc_a', messageId: 'm2', position: 11, createTime: t('11') }, // latest in oc_a
    { chatId: 'oc_a', messageId: 'm3', position: 9, createTime: t('08') },
    { chatId: 'oc_b', messageId: 'm4', position: 5, createTime: t('10') },
  ];
  const out = dedupeByChat(items).sort((a, b) => a.chatId.localeCompare(b.chatId));
  assert.equal(out.length, 2);
  assert.equal(out[0].messageId, 'm2');       // newest of oc_a wins
  assert.equal(out[0].chatUnreadCount, 3);     // three unread in oc_a
  assert.equal(out[1].messageId, 'm4');
  assert.equal(out[1].chatUnreadCount, 1);
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

  assert.ok(card.header.title.content.startsWith('📋'));
  const text = JSON.stringify(card.elements);
  assert.ok(text.includes('HIGH PRIORITY'));
  assert.ok(text.includes('LOW / FYI'));
  assert.ok(text.includes('more low/FYI'));   // low bucket: only lowDisplayLimit shown, rest summarised
  assert.ok(text.includes('checkout is throwing 500s')); // verbatim message excerpt rendered
  assert.ok(text.includes('Alice'));          // group sender prefixed on the excerpt
  assert.ok(text.includes('📣 @all'));         // broadcast tag rendered on the @all item
  assert.ok(text.includes('hint'));           // footer
});
