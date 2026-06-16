import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MS_PER_HOUR } from './time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, '..', 'state.json');

const EMPTY_STATE = {
  lastRunAt: null,
  doneMessageIds: [],
  snoozedMessages: [], // [{ messageId, snoozeUntil }]
  // Snapshot of the most recently delivered digest, so `done`/`snooze` can map
  // the numbers shown on the card to message_ids and re-render WITHOUT another
  // fetch/classify round-trip.
  lastDigest: null, // { generatedAt, since, items: [ normalized+classified item ] }
};

export async function load() {
  if (!existsSync(STATE_PATH)) return { ...EMPTY_STATE };
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY_STATE, ...parsed };
  } catch (err) {
    throw new Error(`state.json is corrupt (${err.message}). Fix or delete it.`);
  }
}

export async function save(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
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
