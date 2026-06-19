/** Time constants + the human-facing date formatting used across the app. */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

const DATE_FORMAT = {
  weekday: 'short', day: '2-digit', month: 'short',
  hour: 'numeric', minute: '2-digit', hour12: true,
};

/** "Tue 16 Jun, 3:51 pm" — date + time, used for the digest's generated-at title. */
export function formatDateTime(date) {
  return date.toLocaleString('en-GB', DATE_FORMAT);
}

/**
 * "Tue 16 Jun" — date only, no time. Used for the lookback-window label: it's a
 * fixed N-hours-ago point whose time-of-day always mirrors "now", so showing the
 * time made the window look static. The day is the meaningful part.
 */
export function formatDate(date) {
  return date.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
}

/** Human elapsed time: "just now" / "45m ago" / "2h ago" / "3d ago". */
export function relativeTime(date, now = new Date()) {
  if (!date) return '';
  const minutes = Math.round((now.getTime() - date.getTime()) / MS_PER_MINUTE);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
