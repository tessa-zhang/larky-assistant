import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSelf } from '../src/lark.js';

async function fakeCli(t, { persistent = false, message = 'token already refreshed by another process' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'inlark-refresh-test-'));
  const previousPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  });
  // This executable never reads credentials. HOME is an empty temporary directory.
  await writeFile(join(dir, 'lark-cli'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, 'calls.json');
const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
calls.push({ args: process.argv.slice(2), home: process.env.HOME });
fs.writeFileSync(file, JSON.stringify(calls));
if (calls.length === 1 || ${persistent}) {
  process.stderr.write(${JSON.stringify(`[lark-cli] uat-client: ${message}`)});
  process.exit(1);
}
process.stdout.write(JSON.stringify({ identities: { user: { available: true, openId: 'ou_synthetic', userName: 'Synthetic' } } }));
`, { mode: 0o700 });
  process.env.PATH = `${dir}:${previousPath}`;
  return { dir, calls: async () => JSON.parse(await readFile(join(dir, 'calls.json'), 'utf8')) };
}

test('Lark read retries a concurrent token refresh once under the same HOME and profile', async (t) => {
  const cli = await fakeCli(t);
  const ambientHome = process.env.HOME;
  const user = await getSelf(cli.dir);
  assert.equal(user.openId, 'ou_synthetic');
  const calls = await cli.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].home, cli.dir);
  assert.deepEqual(calls[0].args, ['auth', 'status', '--profile', 'larky']);
  assert.equal(process.env.HOME, ambientHome);
});

test('Lark refresh retry is bounded and does not retry revoked tokens', async (t) => {
  for (const message of ['token already refreshed by another process', 'refresh failed (code=20064)']) {
    await t.test(message, async (t) => {
      const cli = await fakeCli(t, { persistent: true, message });
      await assert.rejects(getSelf(cli.dir));
      assert.equal((await cli.calls()).length, message.startsWith('token already') ? 2 : 1);
    });
  }
});
