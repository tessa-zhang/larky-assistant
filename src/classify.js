import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const SYSTEM_PROMPT = `You are a triage assistant for a product manager at a travel tech company (Traveloka).
You will receive a list of Lark messages that @mentioned the user or were sent as DMs.
Your job is to classify each message by urgency and category.

Return ONLY a valid JSON array. No preamble, no markdown, no explanation.

Urgency:
- "high": action required today — incidents, outages, blocking issues, explicit sign-off requests, anything with urgent/ASAP/blocking/down/broken
- "medium": response needed but not time-critical — reviews, questions, feedback requests
- "low": informational only, no action needed

Broadcasts: a message with "is_broadcast": true was sent to a whole channel via @all — it is NOT directed at the user personally. Bias these to "low"/"fyi". Only use "medium" if it demands a concrete action the user must personally take (e.g. RSVP, fill a form by a deadline); only use "high" for a genuine incident/outage.

Category:
- "incident": something broken or degraded in production
- "decision_needed": user's explicit approval or choice is required
- "review_request": PRD, doc, code, or design review
- "question": user is being asked something
- "fyi": informational only

Summary: One sentence, max 15 words, plain English. Focus on what the sender needs from the user.

Input format:
[
  { "message_id": "...", "sender": "...", "chat_name": "...", "is_broadcast": false, "text": "..." },
  ...
]

Output format:
[
  { "message_id": "...", "urgency": "high|medium|low", "category": "...", "summary": "..." },
  ...
]`;

const VALID_URGENCY = new Set(['high', 'medium', 'low']);
const VALID_CATEGORY = new Set(['incident', 'decision_needed', 'review_request', 'question', 'fyi']);

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

async function classifyChunk(client, items) {
  const input = items.map((it) => ({
    message_id: it.messageId,
    sender: it.senderName,
    chat_name: it.chatName || (it.isDM ? 'Direct message' : 'group'),
    is_broadcast: !!it.isBroadcast, // @all blast — bias low (see system prompt)
    text: it.text.slice(0, 2000), // keep payload bounded
  }));
  const resp = await client.messages.create({
    model: config.model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(input) }],
  });
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return extractJson(text);
}

/**
 * Classify all items, chunked across Claude calls (run concurrently).
 * Returns Map<message_id, { urgency, category, summary }>.
 * Missing/invalid entries fall back to low/fyi so a message is never dropped.
 */
export async function classify(items) {
  const result = new Map();
  if (items.length === 0) return result;

  if (!config.anthropicApiKey) {
    // No key configured — degrade to heuristic-free fallback rather than crash.
    for (const it of items) result.set(it.messageId, fallback(it));
    return result;
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const chunks = chunk(items, CHUNK_SIZE);

  const settled = await Promise.allSettled(chunks.map((c) => classifyChunk(client, c)));

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
