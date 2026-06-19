import { execFile } from 'node:child_process';

/**
 * Thin wrapper around the `lark-cli` binary. lark-cli owns all Lark auth
 * (token storage + refresh) and decodes message content for us, so we just
 * shell out and parse the JSON it prints to stdout.
 */

const MAX_BUFFER = 64 * 1024 * 1024; // messages + cards can be large
const MAX_SEARCH_PAGES = '40'; // auto-pagination ceiling for messages-search
const REACTION_BATCH_SIZE = 20; // Lark caps reactions/batch_query at 20 message_ids/request
const REACTION_PAGE_SIZE = 10; // Lark caps reactions returned per message at 10

function runRaw(args) {
  return new Promise((resolve, reject) => {
    execFile('lark-cli', args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
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
      if (err) return reject(new Error(`lark-cli ${args[0]} failed: ${stderr || err.message}`));
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

/** Resolve current identity: open_id, display name, and brand (lark|feishu). */
export async function getSelf() {
  const status = await runRaw(['auth', 'status']);
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
  };
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
 * opts: { isAtMe, chatType: 'group'|'p2p', start, end, excludeSenderType }
 */
export async function searchMessages(opts = {}) {
  const args = ['im', '+messages-search', '--as', 'user', '--page-all', '--page-limit', MAX_SEARCH_PAGES, '--json'];
  if (opts.isAtMe) args.push('--is-at-me');
  if (opts.chatType) args.push('--chat-type', opts.chatType);
  if (opts.start) args.push('--start', toLarkTime(opts.start));
  if (opts.end) args.push('--end', toLarkTime(opts.end));
  if (opts.excludeSenderType) args.push('--exclude-sender-type', opts.excludeSenderType);
  if (opts.sender) args.push('--sender', opts.sender);
  const res = await runRaw(args);
  return res.data?.messages || res.messages || [];
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
export async function getReactedMessageIds(messageIds, selfOpenId) {
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
        ]);
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
export async function getChatName(chatId, as = 'user') {
  if (!chatId) return null;
  if (chatNameCache.has(chatId)) return chatNameCache.get(chatId);
  try {
    // chat_id is a path param — lark-cli takes it via --params, not a flag.
    const res = await runRaw(['im', 'chats', 'get', '--params', JSON.stringify({ chat_id: chatId }), '--as', as, '--json']);
    const name = res.data?.name || res.name || null;
    chatNameCache.set(chatId, name);
    return name;
  } catch {
    chatNameCache.set(chatId, null);
    return null;
  }
}
