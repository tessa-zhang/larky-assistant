import { execFile } from 'node:child_process';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * At-rest encryption for state.lastDigest (R17 — the chunk of state.json that
 * holds plaintext message content + AI summaries). AES-256-GCM: authenticated
 * (detects tampering), industry default, built into Node's `crypto`.
 *
 * The 32-byte key lives in the macOS Keychain under one entry, shared across
 * all users — see `getKey`. Keychain is OS-vaulted and gated by your login
 * session, so an attacker with raw repo access gets ciphertext they can't
 * decrypt, which is the exact threat this closes (see SPEC.md R17).
 */

const KEYCHAIN_SERVICE = 'inlark';
const KEYCHAIN_ACCOUNT = 'state-key';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12;  // GCM standard
const TAG_BYTES = 16; // GCM auth tag

/**
 * Read the state-encryption key from macOS Keychain, or create one on first
 * run. Cached per-process so a long-lived `listen` doesn't prompt Keychain on
 * every save. A found-but-malformed entry throws (fail hard — see src/index.js's
 * `reset-key` for the recovery path) rather than silently regenerating, since
 * regenerating would turn every existing encrypted lastDigest into unreadable
 * garbage without any warning to the owner.
 */
let cachedKey = null;
export async function getKey() {
  if (cachedKey) return cachedKey;
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w',
    ]);
    const key = Buffer.from(stdout.trim(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Keychain entry for ${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT} is malformed ` +
        `(expected ${KEY_BYTES} bytes, got ${key.length}). Run \`npm run reset-key\` ` +
        `to generate a fresh key (any pending \`done\`/\`snooze\` references will be ` +
        `dropped — run \`npm run inlark\` after to rebuild them from Lark).`
      );
    }
    cachedKey = key;
    return key;
  } catch (err) {
    // `security find-generic-password` exits 44 when the entry doesn't exist —
    // that's first-run, not an error; mint a fresh key. Any other failure
    // (locked keychain, permission denied, missing `security` binary) is a
    // genuine problem: throw it rather than regenerate on top of what might
    // be a transiently-unreadable live key.
    if (err.code === 44 || /could not be found/i.test(err.stderr || '')) {
      return createKey();
    }
    throw new Error(`Keychain read failed: ${err.message}. Fix Keychain access or run \`npm run reset-key\` to overwrite.`);
  }
}

/** Mint and store a fresh 32-byte key. Used on first run and by `reset-key`. */
export async function createKey() {
  const key = randomBytes(KEY_BYTES);
  await execFileAsync('security', [
    'add-generic-password',
    '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT,
    '-w', key.toString('base64'),
    '-U', // update in place if the entry already exists (reset-key path)
  ]);
  cachedKey = key;
  return key;
}

/**
 * Encrypt a JSON-serializable value. Returns `{ enc: "<base64 iv||ct||tag>" }` —
 * a wrapper object so state.save can distinguish an encrypted field from a
 * plaintext one at load time (migration). The IV is random per call (never
 * reused with the same key, which is the one hard rule for GCM).
 */
export async function encrypt(value) {
  const key = await getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: Buffer.concat([iv, ct, tag]).toString('base64') };
}

/**
 * Decrypt a wrapper object produced by `encrypt`. Throws on tamper (GCM auth
 * tag mismatch) — never returns a possibly-forged value silently.
 */
export async function decrypt(wrapper) {
  if (!wrapper || typeof wrapper.enc !== 'string') {
    throw new Error('decrypt: expected { enc: "<base64>" }');
  }
  const key = await getKey();
  const buf = Buffer.from(wrapper.enc, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('decrypt: ciphertext too short');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

/** Is this value already an encrypted wrapper? Used by state.load for migration. */
export function isEncrypted(value) {
  return value && typeof value === 'object' && typeof value.enc === 'string';
}

// Test seam: let unit tests swap in a known key without touching Keychain.
export function _setKeyForTests(key) {
  cachedKey = key && Buffer.isBuffer(key) ? key : null;
}
