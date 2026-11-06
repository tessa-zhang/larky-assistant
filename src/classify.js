import { config } from './config.js';

/**
 * The triage system prompt, parameterised by the user's display name. Knowing WHO
 * we triage for is essential to the core judgement below: distinguishing a message
 * that ASKS the user to act from one that merely NAMES them (routing/FYI). Without
 * the name the model can't tell "please mention Tessa for X" (about her) from
 * "Tessa, can you approve X?" (to her).
 */
export function systemPrompt(userName) {
  const you = userName || 'the user';
  return `You are a triage assistant for a product manager at a travel tech company (Traveloka).
You triage the inbox of ONE specific person: **${you}**. In messages they are usually @mentioned by that name. For EACH item, judge how much ${you} PERSONALLY needs to act on it, and summarise what they must do.

Return ONLY a valid JSON array. No preamble, no markdown, no explanation. The output MUST parse with JSON.parse — in particular, NO trailing comma before a closing \`}\` or \`]\` (e.g. \`{"summary":"x",}\` is invalid; write \`{"summary":"x"}\`).

Each item has EITHER:
- "text": a single message, OR
- "messages": a chronological bundle to read as ONE conversation — a DM's unread run ("kind":"dm") or a group thread ("kind":"thread"). Entries are { "from": who, "text": ... }; "from":"me" is ${you}'s own message. A "(N earlier messages omitted)" entry marks a gap — do not assume the bundle is complete.

When "messages" is present, summarise the WHOLE bundle, not just the last line — the actionable ask often spans several messages or sits earlier in a thread. For a thread, focus on what ${you} is being asked to do given the discussion.

Urgency — judge by WHAT ${you} MUST PERSONALLY DO, not by how dramatic the topic sounds. A message can describe a serious incident yet require nothing from ${you} (they're only named for awareness or routing) — that is "low" FOR THEM. Always separate the topic's severity from ${you}'s own action.
- "high": ${you} THEMSELVES must act today — they are the one being asked to decide, approve, sign off, unblock, or answer something time-critical; or it's an incident they personally own.
- "medium": ${you}'s input or response is wanted but not time-critical — a review, a question directed at them, feedback they owe.
- "low": no action needed FROM ${you} — informational/FYI, or they're only named for awareness, context, or routing.

Named ≠ asked (read this — it's the crux). Being @mentioned does NOT by itself mean ${you} must act. Rate "low"/"fyi" when ${you} is REFERENCED rather than ASKED, even if the subject is urgent:
- routing / hand-off notes that name ${you} so OTHERS act — e.g. "please mention ${you} for warehouse issues", "loop in ${you}", "${you} handles X", "escalate to ${you}'s team": the ask falls on the reader, not on ${you};
- cc / FYI-for-visibility, or ${you} named only in passing;
- status updates where no one is asked to do anything.
The test for "high"/"medium": does the SENDER need ${you} to do something? If they are informing, routing, or merely copying ${you}, it is "low"/"fyi" regardless of how urgent the topic is. Rate up ONLY when a concrete action lands on ${you} personally.

Direct ask always wins — a routing marker never cancels one. If the message addresses ${you} by name and asks them a question or gives them an imperative ("${you}, can you check…", "${you} mind looking at…", "please confirm, ${you}"), that IS a concrete action on ${you} — rate "medium" or "high", NOT "low". A literal "cc:" / "fyi:" / "loop in" prefix is a weak lexical cue, not a veto: colleagues often write "cc: @${you}, can you check X?" when they genuinely need ${you}'s answer. The sentence itself always wins over the prefix. The same applies when the ask is buried in a long thread or follows a lot of team chatter — a direct question to ${you} by name is still an ask, however deep it sits. Pair this with the structural evidence: a message with "tagged_count": 1 (or ${you} named in a short list) that addresses ${you} by name with a question/imperative is almost always a real ask — don't demote it to "low" because the thread's overall topic is being handled by someone else.

How directly was ${you} addressed? Items carry "tagged_count" (how many people the message @mentioned in total) and "my_tag_position" (${you}'s 1-based slot in that tag list, so 1 = named first). "is_broadcast": true means it went to the whole channel via @all, naming nobody individually. Together these describe a SPECTRUM of directedness, most to least personal:
- a DM, or "tagged_count": 1 — ${you} is the only person named: as personal as it gets, and most likely a real ask;
- a short tag list (${you} and a couple of others) — still pointed; a genuine request usually looks like this;
- a long tag list — the more people named, the more likely ${you} is one of many recipients of a status update, Q&A card, or release note rather than the person being asked;
- "is_broadcast": true (@all) — the far end: addressed to everyone, therefore to no one in particular.
Weigh this as EVIDENCE, never as a rule — the sentence itself always wins. A 12-person thread saying "@${you} please approve this today" is a real ask; a 2-person tag saying "fyi, closing this out" is still fyi. Judge relative to the chat: what counts as a "long" tag list differs between a 5-person squad and a 200-person channel.
"my_tag_position" is the WEAKEST of these signals — being named first sometimes means the ask is primarily ${you}'s, but tag order just as often reflects a roster, a template, or alphabetical habit. Let it tip only a decision that is otherwise balanced; never demote a clear ask because ${you} was named second.
For @all specifically: bias to "low"/"fyi". Use "medium" only if it demands a concrete action ${you} must personally take (RSVP, form by a deadline); "high" only for a genuine incident/outage ${you} owns.

Category:
- "incident": something broken or degraded in production
- "decision_needed": ${you}'s explicit approval or choice is required
- "review_request": PRD, doc, code, or design review
- "question": ${you} is being asked something
- "fyi": informational only, or ${you} is only named/looped in (no action on them)

Summary: max 15 words, plain English, even for a multi-message bundle. LEAD WITH THE ASK (what ${you} must do / decide), don't enumerate the messages. When nothing is asked of ${you}, say so plainly (e.g. "FYI: warehouse routing note — no action needed from you").

Input format ("tagged_count"/"my_tag_position" are omitted when ${you} wasn't named directly, e.g. an @all or a DM):
[
  { "message_id": "...", "sender": "...", "chat_name": "...", "is_broadcast": false, "tagged_count": 2, "my_tag_position": 1, "text": "..." },
  { "message_id": "...", "sender": "...", "chat_name": "...", "is_broadcast": false, "tagged_count": 9, "my_tag_position": 6, "kind": "thread", "messages": [ { "from": "...", "text": "..." }, ... ] },
  ...
]

Output format (one object per item, keyed by its message_id):
[
  { "message_id": "...", "urgency": "high|medium|low", "category": "...", "summary": "..." },
  ...
]`;
}

const VALID_URGENCY = new Set(['high', 'medium', 'low']);
const VALID_CATEGORY = new Set(['incident', 'decision_needed', 'review_request', 'question', 'fyi']);

// Fallback when classification is unavailable (missing config, HTTP/network error,
// parse error, or invalid fields). The low/fyi values preserve the normal result shape,
// but commands.js detects `fallback: true` and renders the whole run through the
// classification-free DM/@-mention card. These values are never presented as a real
// urgency judgement.
function fallback(item) {
  return {
    urgency: 'low',
    category: 'fyi',
    summary: item.text.length > 90 ? item.text.slice(0, 87) + '…' : item.text,
    // Marks this as a DEGRADED result, not a real judgement — callers (commands.js)
    // must never persist this to the thread summary cache. Without this flag, a
    // transient classify outage (bad key, wrong model, timeout) permanently poisons
    // the cache: the fallback gets cached as if it were real, and since cache hits
    // refresh their own recency, it's served forever until the thread itself changes.
    fallback: true,
  };
}

/**
 * Pull a JSON array out of the model's reply. Robust to several things non-Claude
 * (and sometimes Claude) models do despite the "ONLY a valid JSON array" instruction:
 *  - wrap it in a ```json … ``` fence,
 *  - preface it with a conversational sentence,
 *  - emit trailing commas before `]` or `}` (invalid JSON, but a very common LLM slip),
 *  - **truncate the response mid-array** when the chunk's output exceeds max_tokens
 *    — the stream ends on an incomplete object with no closing `]` (confirmed live
 *    2026-10-12). salvagePartial walks the complete objects from the start and
 *    returns however many parsed cleanly, so the chunk degrades to "classified
 *    the first K items, fell back the rest" instead of losing everyone.
 * On failure the thrown error carries a snippet of the raw content so the chunk-level
 * logger can show what actually came back — not just "no JSON array in model output".
 */
export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : text).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  const snippet = () => `raw: ${JSON.stringify(body.slice(0, 300))}${body.length > 300 ? '…' : ''}`;
  if (start === -1) throw new Error(`no JSON array in model output (${snippet()})`);

  // Happy path: a complete array (start AND end). Try strict parse, then a
  // trailing-comma cleanup pass.
  if (end !== -1 && end > start) {
    const slice = body.slice(start, end + 1);
    try { return JSON.parse(slice); } catch { /* fall through */ }
    try { return JSON.parse(slice.replace(/,(\s*[\]}])/g, '$1')); } catch { /* fall through */ }
  }

  // No closing `]`, or neither parse worked: the response is truncated. Salvage
  // whatever complete `{…}` entries we got before the cut.
  const salvaged = salvagePartial(body.slice(start + 1));
  if (salvaged.length) return salvaged;
  throw new Error(`JSON parse failed, salvaged 0 items (${snippet()})`);
}

/**
 * Walk a truncated array body and return every complete top-level object before
 * the stream was cut. Scans char-by-char tracking brace depth and string state,
 * emits each `{...}` the moment its matching `}` closes. One `JSON.parse` per
 * candidate — fast enough for a few dozen entries, and lets us honour
 * trailing-comma cleanup on a per-object basis too.
 */
function salvagePartial(body) {
  const out = [];
  let depth = 0, inString = false, escape = false, objStart = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { if (depth === 0) objStart = i; depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const chunk = body.slice(objStart, i + 1);
        try { out.push(JSON.parse(chunk)); }
        catch { try { out.push(JSON.parse(chunk.replace(/,(\s*[\]}])/g, '$1'))); } catch { /* skip */ } }
        objStart = -1;
      }
    }
  }
  return out;
}

// Messages per model call. Bounded so each response's JSON stays well within
// max_tokens — batching too many at once truncates the response mid-array and
// silently drops everyone to fallback once the list gets long. Lowered from
// 40 → 20 after Tessa's inbox (busy threads with bundled messages → longer
// per-item outputs) hit the limit on claude-sonnet-5 via LiteLLM (2026-10-12).
// Pair with max_tokens: 16384 below. If this still truncates, drop again.
const CHUNK_SIZE = 20;
const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [500, 1500];
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toInput(it) {
  const base = {
    message_id: it.messageId,
    sender: it.senderName,
    chat_name: it.chatName || (it.isDM ? 'Direct message' : 'group'),
    is_broadcast: !!it.isBroadcast, // @all blast — the far end of the directedness spectrum
  };
  // Directedness evidence (see systemPrompt): how many people were tagged and where the
  // user sat in that list. Only present when the user was named directly — omitted rather
  // than sent as null so the model isn't asked to interpret a placeholder.
  if (it.myTagPosition != null) {
    base.tagged_count = it.taggedCount;
    base.my_tag_position = it.myTagPosition;
  }
  // R6: a bundled row (DM unread run / thread slice) → send the whole conversation;
  // otherwise the single message, as before. Per-message text is already clipped at
  // bundle-build time, so just bound the single-message path here.
  if (it.bundle && it.bundle.length) {
    return { ...base, kind: it.bundleType, messages: it.bundle.map((m) => ({ from: m.you ? 'me' : (m.sender || '—'), text: m.text })) };
  }
  return { ...base, text: it.text.slice(0, 2000) };
}

/**
 * Distinguish "can't reach the endpoint" (DNS/connect/TLS/timeout — a network or
 * VPN problem, see the ANTHROPIC_BASE_URL host) from "reached it, got rejected"
 * (401/403 auth, 404 wrong path/model, 429 rate limit, 5xx upstream) from a
 * malformed response (JSON parse). The bare `.message` alone collapses all of
 * these into one indistinguishable string, which is exactly what made the
 * fallback silent. Node's `fetch` sets `err.cause.code` on network failures
 * (ENOTFOUND, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT…); classifyChunk attaches
 * `.status` + `.body` on non-2xx HTTP responses.
 */
function describeError(err) {
  if (!err) return { kind: 'unknown' };
  const cause = err.cause;
  if (cause?.code) {
    return { kind: 'network', code: cause.code, message: cause.message || err.message };
  }
  if (typeof err.status === 'number') {
    return { kind: 'http', status: err.status, name: err.name, body: err.body || err.message };
  }
  return { kind: 'other', name: err.name, message: err.message };
}

async function classifyChunk({ apiKey, baseUrl }, items, userName) {
  // LiteLLM's OpenAI-compatible endpoint — provider-agnostic across whatever
  // model the virtual key is allow-listed for (Claude, GPT, Gemini, DeepSeek…).
  // The previous Anthropic-SDK path only worked while LiteLLM proxied a real
  // Claude model; it 403'd silently when Traveloka's allow-list changed. See
  // SPEC "Classification endpoint". Run `npm run probe-models` to list the
  // ids this virtual key can actually hit.
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      // 16384 (up from 8192) buys headroom so a bundled-thread row's longer
      // output (per-item JSON ≈ 150–250 chars) doesn't hit the ceiling on a
      // 20-item chunk. Combined with CHUNK_SIZE=20 above, the response has
      // ~2x the slack it used to. If a response still truncates, extractJson
      // salvages the complete entries — the rest fall back row-by-row.
      model: config.model,
      max_tokens: 16384,
      messages: [
        { role: 'system', content: systemPrompt(userName) },
        { role: 'user', content: JSON.stringify(items.map(toInput)) },
      ],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`LiteLLM ${resp.status}`);
    err.status = resp.status;
    err.body = body.slice(0, 500);
    throw err;
  }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return extractJson(text);
}

async function classifyChunkWithRetry(client, items, userName, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await classifyChunk(client, items, userName);
    } catch (error) {
      const code = error.cause?.code || error.code;
      const transient = TRANSIENT_NETWORK_CODES.has(code) || error.name === 'TimeoutError';
      if (!transient || attempt >= RETRY_DELAYS_MS.length) throw error;
      // A reset on wake/VPN reconnect must not turn an otherwise healthy inbox
      // into a fallback on the first attempt. Retry only this failed chunk;
      // auth/gateway HTTP errors and invalid model output keep their own paths.
      console.warn(`[classify] chunk ${label} transport failure (${code || error.name}); retry ${attempt + 1}/${RETRY_DELAYS_MS.length}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Credentials bag for classifyChunk. Kept as an export so test/unit.test.js
 * can import it to prove the module parses cleanly. Not an SDK client — the
 * OpenAI-compatible path is just a `fetch` call.
 */
export function buildClient() {
  return { apiKey: config.anthropicApiKey, baseUrl: config.anthropicBaseUrl };
}

/**
 * Classify all items, chunked across Claude calls (run concurrently).
 * Returns Map<message_id, { urgency, category, summary }>.
 * `userName` is woven into the prompt so urgency is judged relative to what THIS
 * user must do (not the topic's intrinsic severity) — see systemPrompt.
 * Missing/invalid entries fall back to low/fyi so a message is never dropped.
 */
export async function classify(items, { userName } = {}) {
  const result = new Map();
  if (items.length === 0) return result;

  if (!config.anthropicApiKey || !config.anthropicBaseUrl) {
    // No LiteLLM credentials configured — degrade to heuristic-free fallback rather than crash.
    for (const it of items) result.set(it.messageId, fallback(it));
    return result;
  }

  const client = buildClient();
  const chunks = chunk(items, CHUNK_SIZE);

  const settled = await Promise.allSettled(chunks.map((c, i) => classifyChunkWithRetry(client, c, userName, `${i + 1}/${chunks.length}`)));

  const byId = new Map();
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      for (const p of s.value) byId.set(p.message_id, p);
    } else {
      console.error(`[classify] chunk ${i + 1}/${chunks.length} failed; those items fall back.`, describeError(s.reason));
    }
  });

  for (const it of items) {
    const p = byId.get(it.messageId);
    if (p && VALID_URGENCY.has(p.urgency) && VALID_CATEGORY.has(p.category) && p.summary) {
      result.set(it.messageId, { urgency: p.urgency, category: p.category, summary: String(p.summary).trim(), fallback: false });
    } else {
      result.set(it.messageId, fallback(it));
    }
  }
  return result;
}
