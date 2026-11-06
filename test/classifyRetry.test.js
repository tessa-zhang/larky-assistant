import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.js';
import { config } from '../src/config.js';

function setup(t, fetch) {
  const previous = { ...config };
  t.after(() => Object.assign(config, previous));
  Object.assign(config, { anthropicApiKey: 'synthetic-key', anthropicBaseUrl: 'https://gateway.example.invalid', model: 'test-model' });
  return t.mock.method(globalThis, 'fetch', fetch);
}

function items(count) {
  return Array.from({ length: count }, (_, i) => ({ messageId: `om_${i}`, text: 'Please review', senderName: 'Synthetic' }));
}

function success(request) {
  const input = JSON.parse(JSON.parse(request.body).messages[1].content);
  return Response.json({ choices: [{ message: { content: JSON.stringify(input.map((item) => ({
    message_id: item.message_id, urgency: 'medium', category: 'review_request', summary: 'Review the proposal',
  }))) } }] });
}

function reset() {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
}

test('classification recovers from the captured ECONNRESET and retries only the failed chunk', async (t) => {
  const calls = new Map();
  const fetch = setup(t, async (_url, request) => {
    const firstId = JSON.parse(JSON.parse(request.body).messages[1].content)[0].message_id;
    calls.set(firstId, (calls.get(firstId) || 0) + 1);
    if (firstId === 'om_20' && calls.get(firstId) === 1) throw reset();
    return success(request);
  });
  const result = await classify(items(41), { userName: 'Synthetic' });
  assert.equal(result.size, 41);
  assert.ok([...result.values()].every((value) => value.fallback === false));
  assert.deepEqual([...calls].sort(), [['om_0', 1], ['om_20', 2], ['om_40', 1]]);
  assert.ok(fetch.mock.calls.every((call) => call.arguments[1].signal instanceof AbortSignal), 'each request has a deadline');
});

test('persistent connection resets stop after three attempts and retain every item in fallback', async (t) => {
  const fetch = setup(t, async () => { throw reset(); });
  const result = await classify(items(2));
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(result.size, 2);
  assert.ok([...result.values()].every((value) => value.fallback === true));
});

test('gateway 403 is not treated as a transient connection reset', async (t) => {
  const fetch = setup(t, async () => new Response('<html>403 Forbidden</html>', { status: 403 }));
  const result = await classify(items(1));
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.get('om_0').fallback, true);
});
