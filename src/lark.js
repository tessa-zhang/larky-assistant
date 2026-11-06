import { execFile } from 'node:child_process';
import { LARK_CLI_PROFILE } from './config.js';

/**
 * Thin wrapper around the `lark-cli` binary. lark-cli owns all Lark auth
 * (token storage + refresh) and decodes message content for us, so we just
 * shell out and parse the JSON it prints to stdout.
 */

const MAX_BUFFER = 64 * 1024 * 1024; // messages + cards can be large
const MAX_SEARCH_PAGES = '40'; // auto-pagination ceiling for messages-search
const REACTION_BATCH_SIZE = 20; // Lark caps reactions/batch_query at 20 message_ids/request
const REACTION_PAGE_SIZE = 10; // Lark caps reactions returned per message at 10

/**
 * Env-scoping (R2 multi-user): a per-call HOME override, applied as a scoped
 * `env` option on ONE execFile call, never via mutating process.env.HOME —
 * callers of runRaw can be in flight concurrently (the listener dispatches
 * events async), and mutating shared process state across an await boundary
 * would let one user's dispatch clobber another's HOME mid-flight. `home`
 * omitted ⇒ the ambient process HOME (today's single-owner behavior) — the
 * SAME `process.env` reference back, so no override is ever constructed when
 * one isn't needed. See SPEC.md.
 */
export function scopedEnv(home) {
  return home ? { ...process.env, HOME: home } : process.env;
}

async function runRaw(args, options = {}) {
  try {
    return await runRawOnce(args, options);
  } catch (err) {
    // Parallel reads can race lark-cli's token refresh on wake. The losing
    // process exits before the API call; retry once to use the winner's saved
    // token, under the exact same HOME/profile. Never retry a revoked token or
    // an API error here (especially a send whose delivery is uncertain).
    if (!err.refreshRace) throw err;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return runRawOnce(args, options);
  }
}

function runRawOnce(args, { home } = {}) {
  return new Promise((resolve, reject) => {
    // --profile pins the call to our app regardless of lark-cli's global active
    // profile (see LARK_CLI_PROFILE) — every exported function here goes through
    // this one function, so this single append covers all of them.
    const env = scopedEnv(home);
    execFile('lark-cli', [...args, '--profile', LARK_CLI_PROFILE], { maxBuffer: MAX_BUFFER, env }, (err, stdout, stderr) => {
      // lark-cli prints a JSON result to stdout even on many failures; on hard
      // failures the error envelope may be on stderr. Try stdout, then stderr.
      let parsed = tryParse(stdout) ?? tryParse(stderr);
      if (parsed) {
        if (parsed.ok === false) {
          const e = parsed.error || {};
          const error = new Error(`${e.type || 'error'}${e.code ? ` ${e.code}` : ''}: ${e.message || 'unknown'}`);
          error.larkError = e;
          return reject(error);
        }
        return resolve(parsed);
      }
      if (err) {
        const error = new Error(`lark-cli ${args[0]} failed: ${stderr || err.message}`);
        error.refreshRace = /^\[lark-cli\] uat-client: token already refreshed by another process\s*$/.test(stderr.trim());
        return reject(error);
      }
      reject(new Error(`lark-cli ${args[0]}: could not parse output`));
    });
  });
}

function tryParse(s) {
  if (!s) return null;
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/**
 * Resolve current identity: open_id, display name, and brand (lark|feishu).
 * `home` (R2 multi-user) resolves identity under a specific isolated HOME
 * instead of the ambient one — the result echoes `home` back so callers can
 * carry a single `self` object downstream instead of threading two values.
 */
export async function getSelf(home) {
  const status = await runRaw(['auth', 'status'], { home });
  const user = status.identities?.user;
  // `available` is the real gate. status may be 'ready' OR 'needs_refresh' —
  // both are usable, because lark-cli auto-refreshes on the next API call.
  if (!user?.available) {
    throw new Error('User identity unavailable. Run: lark-cli auth login --scope "..."');
  }
  return {
    openId: user.openId,
    userName: user.userName,
    brand: status.brand || 'lark',
    home,
  };
}

/**
 * Hard-refuse if a resolved identity doesn't match who we expect. The opposite
 * of this file's fail-open helpers (getChatName, getReactedMessageIds) —
 * losing a nice-to-have signal there is safe; running under the wrong
 * identity's token is exactly the harm this guards against, so it throws
 * instead of degrading. No-op (returns `resolved` unchanged) when there's
 * nothing to check against.
 */
export function assertIdentity(resolved, expectedOpenId, context = '') {
  if (!expectedOpenId) return resolved;
  if (resolved.openId !== expectedOpenId) {
    throw new Error(
      `IDENTITY MISMATCH${context ? ` (${context})` : ''}: resolved open_id ${resolved.openId} ` +
      `("${resolved.userName}") but expected ${expectedOpenId}. Refusing to run — no digest was ` +
      `composed or delivered. Check for a stale/ambient HOME override or a wrong config value.`
    );
  }
  return resolved;
}

/**
 * lark-cli's messages-search --start/--end want ISO 8601 with a numeric offset
 * and no milliseconds (e.g. 2026-03-25T23:59:59+08:00); a `.sssZ` value fails
 * validation (code 99992402). Normalize to a UTC offset form.
 */
function toLarkTime(v) {
  if (!v) return v;
  const d = v instanceof Date ? v : new Date(v);
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * Search messages with user identity. Returns the raw enriched message array
 * (content already decoded to plain text by lark-cli).
 *
 * opts: { isAtMe, chatType: 'group'|'p2p', start, end, excludeSenderType, home }
 */
export async function searchMessages(opts = {}) {
  const args = ['im', '+messages-search', '--as', 'user', '--page-all', '--page-limit', MAX_SEARCH_PAGES, '--json'];
  if (opts.isAtMe) args.push('--is-at-me');
  if (opts.chatType) args.push('--chat-type', opts.chatType);
  if (opts.start) args.push('--start', toLarkTime(opts.start));
  if (opts.end) args.push('--end', toLarkTime(opts.end));
  if (opts.excludeSenderType) args.push('--exclude-sender-type', opts.excludeSenderType);
  if (opts.sender) args.push('--sender', opts.sender);
  const res = await runRaw(args, { home: opts.home });
  return res.data?.messages || res.messages || [];
}

/**
 * List the messages of a single thread (R6 — thread-summary context). lark-cli's
 * `+threads-messages-list` returns the SAME enriched message shape as
 * messages-search (content already decoded to plain text, real
 * `thread_message_position`, `sender`, `mentions`), so callers can reuse the same
 * normalize path. One bounded call: `sort=desc` returns the newest `pageSize`
 * messages (the @mention + unread tail live there); a thread shorter than `pageSize`
 * comes back whole. Reactions enrichment is skipped (`--no-reactions`) — we only
 * need text for summarisation, and it saves a request per message.
 *
 * `thread` accepts an `omt_`/`om_` id (lark-cli resolves a message id to its thread).
 * Returns the raw message array; [] on any error (fail open — a missing thread
 * bundle just degrades that row to a single-message summary).
 */
const THREAD_PAGE_MAX = 50; // Lark's real cap for this endpoint; >50 silently returns 0.
export async function listThreadMessages(thread, { sort = 'desc', pageSize = THREAD_PAGE_MAX, home } = {}) {
  if (!thread) return [];
  // Clamp hard: lark-cli's --help advertises 500, but page_size > 50 comes back EMPTY
  // (not an error), which would make every thread bundle silently fail open. See SPEC.
  const size = Math.min(Math.max(1, pageSize | 0), THREAD_PAGE_MAX);
  try {
    const res = await runRaw([
      'im', '+threads-messages-list', '--as', 'user', '--json', '--no-reactions',
      '--thread', thread, '--sort', sort, '--page-size', String(size),
    ], { home });
    return res.data?.messages || res.messages || [];
  } catch {
    return [];
  }
}

/**
 * Send a message. `content` is a string for text, or an object (Lark card) for
 * interactive. Returns the new message_id.
 */
export async function sendMessage({ as = 'user', userId, chatId, content, msgType = 'text', idempotencyKey }) {
  const args = ['im', '+messages-send', '--as', as, '--json'];
  if (chatId) args.push('--chat-id', chatId);
  else if (userId) args.push('--user-id', userId);
  else throw new Error('sendMessage requires userId or chatId');

  if (msgType === 'interactive') {
    args.push('--msg-type', 'interactive', '--content', JSON.stringify(content));
  } else {
    args.push('--text', String(content));
  }
  if (idempotencyKey) args.push('--idempotency-key', idempotencyKey);

  const res = await runRaw(args);
  return res.data?.message_id || res.message_id || null;
}

/**
 * Pure: from a `reactions batch_query` response's `success_msg_reaction_details`,
 * the set of message_ids that `selfOpenId` has reacted to.
 */
export function reactedIdsFromDetails(details, selfOpenId) {
  const out = new Set();
  for (const det of details || []) {
    const mine = (det.message_reaction_items || []).some(
      (r) => r.operator?.operator_id === selfOpenId,
    );
    if (mine && det.message_id) out.add(det.message_id);
  }
  return out;
}

/**
 * Of `messageIds`, return the subset the user (`selfOpenId`) has reacted to — a
 * "read/addressed" signal alongside the reply watermark (see SPEC.md). Batched at
 * 20 ids/request (Lark's batch_query cap), run concurrently. **Fails open** per
 * batch: a lookup error leaves those messages un-marked (shown, never hidden) —
 * losing the signal only re-surfaces a message the user can clear with `done`.
 *
 * Blind spot: `page_size_per_message` caps at 10, so on a message with >10
 * reactions where the user's isn't in the first 10, the reaction is missed.
 */
export async function getReactedMessageIds(messageIds, selfOpenId, home) {
  const ids = [...new Set(messageIds)].filter(Boolean);
  if (!ids.length || !selfOpenId) return new Set();

  const batches = [];
  for (let i = 0; i < ids.length; i += REACTION_BATCH_SIZE) {
    batches.push(ids.slice(i, i + REACTION_BATCH_SIZE));
  }

  const reacted = new Set();
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await runRaw([
          'im', 'reactions', 'batch_query', '--as', 'user', '--json',
          '--params', JSON.stringify({ user_id_type: 'open_id' }),
          '--data', JSON.stringify({
            queries: batch.map((message_id) => ({ message_id })),
            page_size_per_message: REACTION_PAGE_SIZE,
          }),
        ], { home });
        for (const id of reactedIdsFromDetails(res.data?.success_msg_reaction_details, selfOpenId)) {
          reacted.add(id);
        }
      } catch {
        // fail open: leave this batch's messages shown.
      }
    }),
  );
  return reacted;
}

/**
 * Best-effort chat name resolution. Requires bot capability + im:chat:readonly;
 * returns null (caller degrades gracefully) when unavailable.
 */
const chatNameCache = new Map();
export async function getChatName(chatId, as = 'user', home) {
  if (!chatId) return null;
  // Cache key is chatId only — a chat's name isn't viewer-dependent within one
  // tenant, so it's safe (and avoids redundant lookups) to share this across users.
  if (chatNameCache.has(chatId)) return chatNameCache.get(chatId);
  try {
    // chat_id is a path param — lark-cli takes it via --params, not a flag.
    const res = await runRaw(['im', 'chats', 'get', '--params', JSON.stringify({ chat_id: chatId }), '--as', as, '--json'], { home });
    const name = res.data?.name || res.name || null;
    chatNameCache.set(chatId, name);
    return name;
  } catch {
    chatNameCache.set(chatId, null);
    return null;
  }
}
