import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MS_PER_HOUR } from './time.js';
import { encrypt, decrypt, isEncrypted } from './crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_DIR = join(__dirname, '..', 'state');
// Per-user state lives in <STATE_DIR>/<open_id>.json so multiple users on one instance
// never clobber each other's done/snooze/digest-snapshot/cache (R2 multi-user — a single
// shared file let one user's `done`/`done all` act on another's digest). STATE_DIR is
// read lazily so a hosted deploy (or a test) can point it elsewhere at runtime.
const stateDir = () => process.env.STATE_DIR || DEFAULT_STATE_DIR;
// Pre-multi-user single-user file at the repo root, migrated into the first user's
// per-user file on load — but ONLY when using the default dir. A custom STATE_DIR
// (test / hosted volume) starts clean and never touches this legacy file.
const LEGACY_STATE_PATH = join(__dirname, '..', 'state.json');

/**
 * Per-user state file path. An open_id is `ou_`+hex, but sanitize defensively so a
 * malformed value can never escape the state dir via path traversal.
 */
function userStatePath(openId) {
  const safe = String(openId || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  return join(stateDir(), `${safe}.json`);
}

const EMPTY_STATE = {
  lastRunAt: null,
  doneMessageIds: [],
  snoozedMessages: [], // [{ messageId, snoozeUntil }]
  // R12 auto-poll change-gate: the sorted messageId set from the last poll
  // check, so a scheduled tick can tell "nothing changed" from "new item
  // arrived" without re-classifying. Synced on every runDigest AND on
  // rerender() (done/snooze), so clearing an item never looks like an
  // external change to the next tick. null until the first poll runs.
  lastPollSignature: null,
  lastPollAt: null,
  // Snapshot of the most recently delivered digest, so `done`/`snooze` can map
  // the numbers shown on the card to message_ids and re-render WITHOUT another
  // fetch/classify round-trip. Fields are kept to the minimum the renderer +
  // done/snooze actually read (R17 data-minimization, 2026-10-08 — see
  // commands.runDigest's KEEP set).
  lastDigest: null, // { generatedAt, since, items: [ lean item ] }
};

export async function load(openId) {
  await mkdir(stateDir(), { recursive: true });
  const p = userStatePath(openId);
  // One-time migration from the pre-multi-user single file: the FIRST user to load
  // inherits it (that's this instance's original single-user owner). Rename it into
  // their per-user file — a move, so no second user picks it up, and it replaces any
  // stale prototype file for that id. Gated to the default dir so a custom STATE_DIR
  // (test / hosted volume) never touches it; new/hosted deploys have no legacy file.
  if (!process.env.STATE_DIR && existsSync(LEGACY_STATE_PATH)) {
    try { await rename(LEGACY_STATE_PATH, p); } catch { /* raced by a concurrent load — fall through */ }
  }
  if (!existsSync(p)) return { ...EMPTY_STATE };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(p, 'utf8'));
  } catch (err) {
    throw new Error(`state for ${openId} is corrupt (${err.message}). Fix or delete ${p}.`);
  }
  // R17 at-rest encryption (2026-10-09): lastDigest holds message text + AI summaries,
  // so it's stored as a GCM-sealed blob under { enc }. Older files have plaintext
  // lastDigest (pre-R17) — pass that through unchanged; it'll be re-encrypted on the
  // next save, migrating the file in place with no action from the owner.
  if (isEncrypted(parsed.lastDigest)) {
    parsed.lastDigest = await decrypt(parsed.lastDigest);
  }
  // Historical cleanup: pre-2026-10-08 files have a plaintext `threadSummaryCache`
  // field holding AI-written thread summaries. The cache was removed; drop any
  // leftover on load so the next save purges it from disk.
  delete parsed.threadSummaryCache;
  return { ...EMPTY_STATE, ...parsed };
}

export async function save(openId, state) {
  await mkdir(stateDir(), { recursive: true });
  // Encrypt only lastDigest — the rest (doneMessageIds, snoozedMessages, timestamps,
  // poll signature) is opaque IDs with no PII, kept readable so you can eyeball
  // whether a run happened without decrypting. See src/crypto.js + SPEC.md R17.
  const onDisk = { ...state };
  if (onDisk.lastDigest != null) onDisk.lastDigest = await encrypt(onDisk.lastDigest);
  await writeFile(userStatePath(openId), JSON.stringify(onDisk, null, 2) + '\n', 'utf8');
}

/** Drop snoozes whose timer has elapsed. Mutates + returns state. */
export function clearExpiredSnoozes(state, now = new Date()) {
  const cutoff = now.getTime();
  state.snoozedMessages = (state.snoozedMessages || []).filter(
    (s) => new Date(s.snoozeUntil).getTime() > cutoff,
  );
  return state;
}

/** Set of message_ids currently hidden (done or actively snoozed). */
export function hiddenMessageIds(state) {
  const set = new Set(state.doneMessageIds || []);
  for (const s of state.snoozedMessages || []) set.add(s.messageId);
  return set;
}

export function markDone(state, messageIds) {
  const set = new Set(state.doneMessageIds || []);
  for (const id of messageIds) set.add(id);
  state.doneMessageIds = [...set];
  // A done item should never also be snoozed.
  state.snoozedMessages = (state.snoozedMessages || []).filter(
    (s) => !messageIds.includes(s.messageId),
  );
  return state;
}

export function snooze(state, messageIds, hours, now = new Date()) {
  const snoozeUntil = new Date(now.getTime() + hours * MS_PER_HOUR).toISOString();
  const byId = new Map((state.snoozedMessages || []).map((s) => [s.messageId, s]));
  for (const id of messageIds) byId.set(id, { messageId: id, snoozeUntil });
  state.snoozedMessages = [...byId.values()];
  return state;
}
