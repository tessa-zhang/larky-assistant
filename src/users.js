import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// R2 multi-user registry: open_id -> isolated HOME path for additional (non-owner)
// users. The owner never appears here — their identity resolves via the ambient
// process HOME, same as before multi-user existed. Low-churn, admin-managed (you
// add a teammate deliberately via `adduser`), so a single flat file is enough —
// unlike state.js's per-user files, which exist because digest state churns per run.
const registryPath = () => process.env.USERS_REGISTRY_PATH || join(__dirname, '..', 'users.json');

export async function loadRegistry() {
  const p = registryPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch (err) {
    throw new Error(`users registry at ${p} is corrupt (${err.message}). Fix or delete it.`);
  }
}

export async function saveRegistry(registry) {
  await writeFile(registryPath(), JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

/**
 * Register a non-owner user. Validates `home` actually exists on disk first —
 * fails fast on a typo'd path rather than letting it surface later as a cryptic
 * failure mid-listen. Does NOT itself verify the HOME's stored token belongs to
 * `openId` — callers (see index.js's `adduser`) should resolve identity under
 * `home` and run it through lark.js's assertIdentity before calling this, so a
 * misconfigured registry entry can never be written in the first place.
 */
export async function registerUser(openId, home, userName) {
  if (!openId || !home) throw new Error('registerUser requires openId and home');
  if (!existsSync(home)) throw new Error(`home path does not exist: ${home}`);
  const registry = await loadRegistry();
  registry[openId] = { home, userName: userName || null, addedAt: new Date().toISOString() };
  await saveRegistry(registry);
  return registry[openId];
}

/** Look up a registered non-owner user by open_id, or null if not registered. */
export async function lookupUser(openId) {
  const registry = await loadRegistry();
  return registry[openId] || null;
}
