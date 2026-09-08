import Anthropic from '@anthropic-ai/sdk';
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

Return ONLY a valid JSON array. No preamble, no markdown, no explanation.

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

// Fallback when classification is unavailable (no API key) or unusable (parse error /
// invalid fields). `low`/`fyi` is safe again now that the card renders EVERY urgency
// (2026-08-11): an unjudged message still appears, just in the collapsed LOW panel, so
// nothing is dropped and a keyless run degrades quietly instead of forcing every item
// into MEDIUM. (It was briefly `medium`/`question` during the action-only experiment,
// when `low` meant "not rendered at all" and a keyless run would have produced an empty
// digest — if a filter on urgency is ever reintroduced, this must change back with it.)
function fallback(item) {
  return {
    urgency: 'low',
    category: 'fyi',
    summary: item.text.length > 90 ? item.text.slice(0, 87) + '…' : item.text,
  };
}

/** Strip ```json fences if the model wrapped its output despite instructions. */
export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : text).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('no JSON array in model output');
  return JSON.parse(body.slice(start, end + 1));
}

// Messages per Claude call. Bounded so each response's JSON stays well within
// max_tokens — batching ALL messages (as the spec suggested) truncates output
// and silently drops everyone to fallback once the list gets long.
const CHUNK_SIZE = 40;

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

async function classifyChunk(client, items, userName) {
  const input = items.map(toInput);
  const resp = await client.messages.create({
    model: config.model,
    max_tokens: 8192,
    system: systemPrompt(userName),
    messages: [{ role: 'user', content: JSON.stringify(input) }],
  });
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return extractJson(text);
}

/**
 * Build the Anthropic client, honouring an optional gateway base URL.
 *
 * Default (ANTHROPIC_BASE_URL unset) is the Anthropic API directly — the data
 * path the SPEC/README privacy note describes. A non-default endpoint means
 * message text leaves for a third party, so we say so on stderr rather than let
 * it happen silently: this is the only place inlark's content exits the machine.
 */
export function buildClient() {
  const { anthropicApiKey: apiKey, anthropicBaseUrl: baseURL } = config;
  if (!baseURL) return new Anthropic({ apiKey });
  console.error(
    `[classify] NOTE: classification is routed via ANTHROPIC_BASE_URL=${baseURL} — ` +
    `message text is sent there, not to api.anthropic.com. Use only an IT-approved gateway.`,
  );
  return new Anthropic({ apiKey, baseURL });
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

  if (!config.anthropicApiKey) {
    // No key configured — degrade to heuristic-free fallback rather than crash.
    for (const it of items) result.set(it.messageId, fallback(it));
    return result;
  }

  const client = buildClient();
  const chunks = chunk(items, CHUNK_SIZE);

  const settled = await Promise.allSettled(chunks.map((c) => classifyChunk(client, c, userName)));

  const byId = new Map();
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      for (const p of s.value) byId.set(p.message_id, p);
    } else {
      console.error(`[classify] chunk ${i + 1}/${chunks.length} failed (${s.reason?.message}); those items fall back.`);
    }
  });

  for (const it of items) {
    const p = byId.get(it.messageId);
    if (p && VALID_URGENCY.has(p.urgency) && VALID_CATEGORY.has(p.category) && p.summary) {
      result.set(it.messageId, { urgency: p.urgency, category: p.category, summary: String(p.summary).trim() });
    } else {
      result.set(it.messageId, fallback(it));
    }
  }
  return result;
}
