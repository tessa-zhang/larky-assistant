import { test } from 'node:test';
import assert from 'node:assert/strict';

import { relativeTime, formatDateTime, MS_PER_HOUR } from '../src/time.js';
import { isExcludedChatName, config } from '../src/config.js';
import { hasMeaningfulText, isUnread } from '../src/fetchMentions.js';
import { extractJson } from '../src/classify.js';
import { buildDigestCard } from '../src/buildCard.js';
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
    { n: 1, urgency: 'high', category: 'incident', summary: 'prod down', isDM: false, chatName: 'ops', link: 'https://x', createTime: NOW },
    ...Array.from({ length: lowCount }, (_, i) => ({
      n: i + 2, urgency: 'low', category: 'fyi', summary: `chatter ${i}`, isDM: true, chatName: 'Bob', link: null, createTime: NOW,
    })),
  ];

  const card = buildDigestCard({ items, since: NOW, generatedAt: NOW, footerHint: 'hint' });

  assert.ok(card.header.title.content.startsWith('📋'));
  const text = JSON.stringify(card.elements);
  assert.ok(text.includes('HIGH PRIORITY'));
  assert.ok(text.includes('LOW / FYI'));
  assert.ok(text.includes(`+2 more`)); // only lowDisplayLimit shown, remainder summarised
  assert.ok(text.includes('hint'));    // footer
});
