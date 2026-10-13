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
