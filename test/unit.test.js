import { test } from 'node:test';
import assert from 'node:assert/strict';

import { relativeTime, formatDateTime, MS_PER_HOUR } from '../src/time.js';
import { isExcludedChatName, config } from '../src/config.js';
import { hasMeaningfulText, isUnread, dedupeByChat } from '../src/fetchMentions.js';
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
    ...Array.from({ length: lowCount }, (_, i) => ({
      n: i + 2, urgency: 'low', category: 'fyi', summary: `chatter ${i}`, isDM: true, chatName: 'Bob', senderName: 'Bob', text: `note ${i}`, chatUnreadCount: 1, link: null, createTime: NOW,
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
  assert.ok(text.includes('hint'));           // footer
});
