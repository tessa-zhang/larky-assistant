import { URGENCY_ORDER, URGENCY_META, config } from './config.js';
import { formatDate, formatDateTime, relativeTime } from './time.js';

/** Subtitle window phrase, e.g. "since Tue 16 Jun" (date only — see formatDate). */
function sinceText(windowStart) {
  return windowStart ? `since ${formatDate(windowStart)}` : 'recently';
}

// Escape lark_md control chars in untrusted text so summaries render literally.
function md(text) {
  return String(text || '').replace(/([\\*_~`\[\]])/g, '\\$1');
}

/**
 * The verbatim message, condensed to a single ~2-line excerpt: strip markup
 * tags and non-text placeholders, collapse whitespace, truncate. Lets you read
 * the actual wording without opening the chat (which would mark it read).
 */
export function previewText(text, max = 160) {
  const s = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[(?:Image|File|Video|Audio|Post|Card|Sticker)[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function itemLabel(item) {
  if (item.isDM) return `${item.chatName || item.senderName || 'Direct message'} · DM`;
  // Group: prefer the resolved chat name; until bot capability is enabled it's
  // null, so fall back to whoever sent the latest unread message.
  const base = item.chatName || (item.senderName ? `${item.senderName} · group` : 'group');
  // A chat can now yield several thread rows (R6) — mark them and, where we have it,
  // append a short topic from the thread head so they're distinguishable at a glance.
  if (item.bundleType === 'thread') return item.threadTopic ? `${base} · 🧵 ${item.threadTopic}` : `${base} · 🧵`;
  return base;
}

/**
 * Card-2.0 elements for one digest item: a markdown block (header + AI summary +
 * verbatim excerpt) followed by an optional jump button. In the v2 schema text is
 * a standalone `markdown` element and a button carries its URL via `behaviors`
 * (the v1 `div`+`lark_md` / `action`+`url` shapes are gone).
 */
function itemBlock(item, now) {
  const meta = URGENCY_META[item.urgency] || URGENCY_META.low;
  const ago = relativeTime(item.createTime, now);
  const more = item.chatUnreadCount > 1 ? ` · +${item.chatUnreadCount - 1} more` : '';
  // @all broadcasts are kept but flagged so a channel-wide blast doesn't read as
  // a personal ping (they're also biased low at classification).
  const broadcast = item.isBroadcast ? ' · 📣 @all' : '';
  const header = `**${item.n}.** ${meta.emoji} **[${md(itemLabel(item))}]** · ${md(item.category)}${broadcast}${ago ? ` · ${ago}` : ''}${more}`;
  const summary = md(item.summary); // AI actionable
  // For group messages, prefix the sender so you know who pinged you.
  const raw = previewText(item.text, config.rawPreviewChars);
  const rawLine = raw ? `\n💬 ${item.isDM ? '' : `**${md(item.senderName)}:** `}${md(raw)}` : '';
  const elements = [
    { tag: 'markdown', content: `${header}\n${summary}${rawLine}` },
  ];
  if (item.link) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '↗ Jump to message' },
      type: 'primary',
      size: 'small',
      behaviors: [{ type: 'open_url', default_url: item.link }],
    });
  }
  return elements;
}

/** Section title line, e.g. "🟢 **LOW / FYI**  (12)". */
function sectionTitle(meta, count) {
  return `${meta.emoji} **${meta.label}**  (${count})`;
}

/**
 * The LOW/FYI bucket as a collapsed `collapsible_panel` (R3). The header still
 * carries the count so you see how many low items exist without expanding; the
 * items (capped + "+N more" line) live inside, revealed on demand. HIGH/MEDIUM
 * are never collapsed — they're rendered flat by the caller.
 */
function lowPanel(bucket, now) {
  const shown = bucket.slice(0, config.lowDisplayLimit);
  const inner = [];
  for (const it of shown) inner.push(...itemBlock(it, now));
  if (bucket.length > shown.length) {
    // (schema 2.0 dropped the `note` element — render the overflow line as markdown.)
    inner.push({ tag: 'markdown', content: `…+${bucket.length - shown.length} more low/FYI (use \`done\` to clear)` });
  }
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: sectionTitle(URGENCY_META.low, bucket.length) },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements: inner,
  };
}

/**
 * Build a Lark interactive card (schema 2.0) from numbered, classified items.
 * `items` must each carry: n, urgency, category, summary, chatName, isDM,
 * createTime, link. HIGH + MEDIUM render expanded; LOW/FYI is collapsed behind a
 * `collapsible_panel` so a busy digest stays scannable (R3).
 */
export function buildDigestCard({ items, since, generatedAt = new Date(), footerHint }) {
  const now = generatedAt;

  // Group by urgency, preserving the high→medium→low order.
  const groups = { high: [], medium: [], low: [] };
  for (const it of items) (groups[it.urgency] || groups.low).push(it);

  const elements = [
    { tag: 'markdown', content: `Showing **${items.length}** mention${items.length === 1 ? '' : 's'} & DM${items.length === 1 ? '' : 's'} ${sinceText(since)}` },
  ];

  for (const key of Object.keys(groups).sort((a, b) => URGENCY_ORDER[a] - URGENCY_ORDER[b])) {
    const bucket = groups[key];
    if (bucket.length === 0) continue;
    const meta = URGENCY_META[key];
    elements.push({ tag: 'hr' });
    if (key === 'low') {
      // Collapsed by default — keeps low/FYI noise out of the way until expanded.
      elements.push(lowPanel(bucket, now));
    } else {
      elements.push({ tag: 'markdown', content: sectionTitle(meta, bucket.length) });
      for (const it of bucket) elements.push(...itemBlock(it, now));
    }
  }

  elements.push({ tag: 'hr' });
  // schema 2.0 dropped the `note` element; the footer is a trusted internal hint
  // (its backticks are intentional code-spans), so render it as markdown unescaped.
  elements.push({ tag: 'markdown', content: footerHint || '↩ type `digest` to refresh' });

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `📋 Your Triage Digest — ${formatDateTime(now)}` },
    },
    body: { elements },
  };
}
