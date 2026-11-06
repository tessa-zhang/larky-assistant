import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDigest } from '../src/commands.js';
import { runMorningDigestBatch } from '../src/morningDigest.js';
import { clearExpiredSnoozes } from '../src/state.js';
import { classify } from '../src/classify.js';
import { config } from '../src/config.js';

function harness({ classifyItems } = {}) {
  let state = { lastPollSignature: null, lastMorningDigestDate: null, lastDigest: null };
  let unavailable = true;
  let classificationCalls = 0;
  const deliveries = [];
  const services = {
    now: () => new Date('2026-10-21T01:00:00Z'),
    store: {
      clearExpiredSnoozes,
      load: async () => structuredClone(state),
      save: async (_id, value) => { state = structuredClone(value); },
    },
    fetchSince: async () => ({
      items: [{ messageId: 'om_test', senderName: 'Colleague', text: 'Please approve today', isDM: true, createTime: new Date() }],
      skipped: {},
    }),
    classify: async (items, options) => {
      classificationCalls++;
      if (classifyItems) return classifyItems(items, options);
      return new Map([['om_test', { urgency: 'high', category: 'decision_needed', summary: 'Approve today', fallback: unavailable }]]);
    },
    deliver: async (_delivery, content) => { deliveries.push(content); },
  };
  const args = { self: { openId: 'ou_test', userName: 'Test' }, delivery: { as: 'bot', userId: 'ou_test' } };
  return {
    run: (options = {}) => runDigest({ ...args, ...options }, services),
    state: () => state,
    replaceState: (value) => { state = structuredClone(value); },
    recover: () => { unavailable = false; },
    classificationCalls: () => classificationCalls,
    deliveries,
  };
}

test('poll retries classification after a degraded digest even when unread messages are unchanged', async () => {
  const h = harness();
  await h.run();
  assert.equal(h.state().lastDigest.cardMode, 'fallback');
  h.recover();
  const result = await h.run({ requireChange: true });
  assert.notEqual(result.sent, false);
  assert.equal(h.state().lastDigest.cardMode, 'prioritized');
  assert.equal(h.classificationCalls(), 2);
  assert.equal(h.deliveries.length, 2);
  await h.run({ requireChange: true });
  assert.equal(h.classificationCalls(), 2, 'healthy unchanged polls still skip');
});

test('morning batch keeps degraded owner eligible and sends a single replacement after recovery', async () => {
  const h = harness();
  const completedUserIds = new Set();
  const args = { owner: { openId: 'ou_test' }, dateKey: '2026-10-21', digestsInFlight: new Set(), completedUserIds };
  const services = { runDigest: (options) => h.run(options), loadRegistry: async () => ({}) };
  const tick = async () => {
    const results = await runMorningDigestBatch(args, services);
    for (const r of results) if (['sent', 'already-sent'].includes(r.status)) completedUserIds.add(r.openId);
    return results;
  };
  const initial = await tick();
  assert.equal(initial[0].status, 'degraded');
  assert.equal(completedUserIds.size, 0);
  assert.equal(h.deliveries.length, 1);
  const throttled = await tick();
  assert.equal(throttled[0].status, 'retry-later');
  assert.equal(h.classificationCalls(), 1);
  const deliveredSnapshot = structuredClone(h.state().lastDigest);
  h.replaceState({ ...h.state(), lastMorningDigestAttemptAt: '2026-10-21T00:00:00Z' });
  await tick();
  assert.equal(h.deliveries.length, 1, 'repeated outage does not resend fallback');
  assert.deepEqual(h.state().lastDigest, deliveredSnapshot, 'failed retry preserves delivered done/snooze mapping');
  h.recover();
  h.replaceState({ ...h.state(), lastMorningDigestAttemptAt: '2026-10-21T00:00:00Z' });
  const recovered = await tick();
  assert.equal(recovered[0].status, 'sent');
  assert.equal(h.state().lastDigest.cardMode, 'prioritized');
  assert.equal(h.state().lastMorningDigestDate, args.dateKey);
  assert.equal(h.deliveries.length, 2);
  assert.deepEqual(await tick(), []);
});

test('already-delivered degraded morning snapshots from before the fix can recover', async () => {
  const h = harness();
  const date = '2026-10-21';
  await h.run({ morningDigestDate: date });
  h.replaceState({ ...h.state(), lastMorningDigestDate: date, lastMorningDigestAttemptAt: null });
  h.recover();
  await h.run({ morningDigestDate: date });
  assert.equal(h.state().lastDigest.cardMode, 'prioritized');
  assert.equal(h.deliveries.length, 2);
});

test('a healthy morning stays complete even if a later manual digest falls back', async () => {
  const h = harness();
  h.recover();
  const date = '2026-10-21';
  await h.run({ morningDigestDate: date });
  h.replaceState({ ...h.state(), lastDigest: { ...h.state().lastDigest, cardMode: 'fallback' } });
  const result = await h.run({ morningDigestDate: date });
  assert.equal(result.reason, 'already-sent');
  assert.equal(h.deliveries.length, 1);
});

test('real classifier HTML 403 can recover on the same unread morning backlog', async (t) => {
  const original = { ...config };
  t.after(() => Object.assign(config, original));
  Object.assign(config, { anthropicApiKey: 'synthetic-test-key', anthropicBaseUrl: 'https://gateway.example.invalid', model: 'test-model' });
  let gatewayAvailable = false;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, 'https://gateway.example.invalid/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer synthetic-test-key');
    if (!gatewayAvailable) return new Response('<html><title>403 Forbidden</title></html>', { status: 403 });
    return Response.json({ choices: [{ message: { content: JSON.stringify([
      { message_id: 'om_test', urgency: 'high', category: 'decision_needed', summary: 'Approve today' },
    ]) } }] });
  });
  const h = harness({ classifyItems: classify });
  const options = { morningDigestDate: '2026-10-21' };
  assert.equal((await h.run(options)).reason, 'degraded');
  assert.equal(h.state().lastMorningDigestDate, null);
  assert.equal(h.state().lastDigest.cardMode, 'fallback');
  gatewayAvailable = true;
  h.replaceState({ ...h.state(), lastMorningDigestAttemptAt: '2026-10-21T00:00:00Z' });
  await h.run(options);
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(h.state().lastDigest.cardMode, 'prioritized');
  assert.equal(h.state().lastDigest.items[0].urgency, 'high');
  assert.equal(h.deliveries.length, 2);
  assert.ok(JSON.stringify(h.deliveries[1]).includes('HIGH PRIORITY'));
});

test('a degraded owner does not block a healthy guest or cause the guest to be resent on retry', async () => {
  const owner = harness();
  const guest = harness();
  guest.recover();
  const completedUserIds = new Set();
  const options = { owner: { openId: 'ou_owner' }, dateKey: '2026-10-21', digestsInFlight: new Set(), completedUserIds };
  const services = {
    loadRegistry: async () => ({ ou_guest: { home: '/synthetic', userName: 'Guest' } }),
    getSelf: async (home) => ({ openId: 'ou_guest', home }),
    assertIdentity: (user, expected) => assert.equal(user.openId, expected),
    runDigest: (args) => (args.self.openId === 'ou_owner' ? owner : guest).run(args),
  };
  const first = await runMorningDigestBatch(options, services);
  assert.deepEqual(first.map((r) => r.status), ['degraded', 'sent']);
  for (const r of first) if (['sent', 'already-sent'].includes(r.status)) completedUserIds.add(r.openId);
  owner.recover();
  owner.replaceState({ ...owner.state(), lastMorningDigestAttemptAt: '2026-10-21T00:00:00Z' });
  const second = await runMorningDigestBatch(options, services);
  assert.deepEqual(second.map((r) => [r.openId, r.status]), [['ou_owner', 'sent']]);
  assert.equal(owner.deliveries.length, 2);
  assert.equal(guest.deliveries.length, 1);
});
