/**
 * Pure wall-clock scheduling for the R12 auto-poll (see SPEC.md). Returns a
 * stable id for the interval "slot" `now` falls into, or null when outside
 * the poll window — so a caller polling every 60s fires exactly once per
 * slot, regardless of when it started or whether it slept through one.
 */
export function currentSlotId(now, { intervalMinutes, startHour, endHour, weekdaysOnly }) {
  if (weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) return null;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const startMin = startHour * 60;
  const endMin = endHour * 60;
  if (minutes < startMin || minutes > endMin) return null;
  const slotMin = startMin + Math.floor((minutes - startMin) / intervalMinutes) * intervalMinutes;
  return `${now.toDateString()}#${slotMin}`;
}

/** Stable local-calendar key used to persist one morning run per user and day. */
export function localDateKey(now) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clockMinutes(value, settingName) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) {
    throw new Error(`${settingName} must be HH:MM in 24-hour time (received ${JSON.stringify(value)})`);
  }
  return hour * 60 + minute;
}

/**
 * Return today's local date once the morning send time has arrived, including
 * the catch-up window after sleep. null means no morning digest is due now.
 * Per-user duplicate suppression is persisted by commands.runDigest.
 */
export function currentMorningDigestDate(now, { time, cutoff, weekdaysOnly }) {
  const sendAt = clockMinutes(time, 'MORNING_DIGEST_TIME');
  const stopAt = clockMinutes(cutoff, 'MORNING_DIGEST_CUTOFF');
  if (stopAt < sendAt) {
    throw new Error('MORNING_DIGEST_CUTOFF must be at or after MORNING_DIGEST_TIME');
  }
  if (weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) return null;

  const currentMinute = now.getHours() * 60 + now.getMinutes();
  if (currentMinute < sendAt || currentMinute > stopAt) return null;
  return localDateKey(now);
}
