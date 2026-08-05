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

/** A schema-2.0 open_url button (Jump). Reused for the row + per-@ expander links. */
function jumpButton(url, label = '↗ Jump to message', type = 'primary') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    size: 'small',
    behaviors: [{ type: 'open_url', default_url: url }],
  };
}

/**
 * Per-@ expander for a bundle with >1 unreplied @you: one line per direct @me
 * (sender + excerpt) with its own jump button, collapsed by default. Keeps R6's
 * single bundle-summary row while making sure no individual ask is buried behind it.
 * Rendered only at top level — never nested inside the LOW/FYI panel (Lark 2.0
 * nested-collapsible support is unverified, and LOW rows are already one tap away).
 */
function mentionsPanel(item) {
  const inner = [];
  for (const m of item.mentions) {
    inner.push({ tag: 'markdown', content: `💬 **${md(m.sender)}:** ${md(previewText(m.text, config.rawPreviewChars))}` });
    if (m.link) inner.push(jumpButton(m.link, '↗ Jump', 'default'));
  }
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: `↳ **${item.mentionCount}** unreplied @s to you` },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements: inner,
  };
}

/**
 * Card-2.0 elements for one digest item: a markdown block (header + AI summary +
 * verbatim excerpt) followed by an optional jump button, and — when `expandable`
 * and the bundle holds >1 unreplied @you — a collapsible per-@ expander. In the v2
 * schema text is a standalone `markdown` element and a button carries its URL via
 * `behaviors` (the v1 `div`+`lark_md` / `action`+`url` shapes are gone).
 */
function itemBlock(item, now, { expandable = false } = {}) {
  const meta = URGENCY_META[item.urgency] || URGENCY_META.low;
  const ago = relativeTime(item.createTime, now);
  // A bundle with >1 direct @me shows a "N @you" badge (unreplied asks to you in this
  // thread/chat); the individual @s live in the expander below. When it shows, drop
  // the generic "+N more" (total unread) to avoid a confusing double count — the @you
  // signal is the one that matters.
  const hasAtYou = item.mentionCount > 1;
  const atYou = hasAtYou ? ` · ${item.mentionCount} @you` : '';
  const more = !hasAtYou && item.chatUnreadCount > 1 ? ` · +${item.chatUnreadCount - 1} more` : '';
  // @all broadcasts are kept but flagged so a channel-wide blast doesn't read as
  // a personal ping (they're also biased low at classification).
  const broadcast = item.isBroadcast ? ' · 📣 @all' : '';
  const header = `**${item.n}.** ${meta.emoji} **[${md(itemLabel(item))}]** · ${md(item.category)}${broadcast}${ago ? ` · ${ago}` : ''}${atYou}${more}`;
  const summary = md(item.summary); // AI actionable
  // For group messages, prefix the sender so you know who pinged you.
  const raw = previewText(item.text, config.rawPreviewChars);
  const rawLine = raw ? `\n💬 ${item.isDM ? '' : `**${md(item.senderName)}:** `}${md(raw)}` : '';
  const elements = [
    { tag: 'markdown', content: `${header}\n${summary}${rawLine}` },
  ];
  if (item.link) elements.push(jumpButton(item.link));
  if (expandable && hasAtYou && item.mentions?.length) elements.push(mentionsPanel(item));
  return elements;
}

/** Section title line, e.g. "🟢 **LOW / FYI**  (12)". */
function sectionTitle(meta, count) {
  return `${meta.emoji} **${meta.label}**  (${count})`;
}

/**
 * The LOW/FYI item blocks (all of them — no cap). Shared by the collapsed panel and
 * the expanded (only-bucket) render.
 */
function lowItems(bucket, now, expandable = false) {
  // Every low item is listed — no display cap. LOW volume is already bounded upstream
  // by MAX_MESSAGES, and each item now carries an assuring "FYI:" summary worth reading,
  // so hiding the tail behind an unreachable "+N more" only removed the ability to act
  // on it. LOW still *collapses* behind the panel (R3) — this just fills it completely.
  const inner = [];
  for (const it of bucket) inner.push(...itemBlock(it, now, { expandable }));
  return inner;
}

/**
 * The LOW/FYI bucket as a collapsed `collapsible_panel` (R3). The header still
 * carries the count so you see how many low items exist without expanding; ALL of
 * them live inside, revealed on demand (no cap). HIGH/MEDIUM are never collapsed —
 * they're rendered flat by the caller.
 */
function lowPanel(bucket, now) {
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
    // expandable:false — no per-@ expander nested inside the LOW/FYI panel.
    elements: lowItems(bucket, now, false),
  };
}

/**
 * Build a Lark interactive card (schema 2.0) from numbered, classified items.
 * `items` must each carry: n, urgency, category, summary, chatName, isDM,
 * createTime, link. HIGH + MEDIUM render expanded; LOW/FYI is collapsed behind a
 * `collapsible_panel` so a busy digest stays scannable (R3) — unless LOW is the
 * *only* bucket, in which case it renders expanded (nothing above it to bury). All
 * low items are listed either way (no cap).
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
      // LOW/FYI still collapses behind a panel so it doesn't bury HIGH/MEDIUM (R3) — but
      // the panel now holds EVERY low item (no cap): expanding it shows them all, each
      // with its assuring "FYI:" summary, instead of "~10 and +N more" with no way to act
      // on the rest. When LOW is the *only* bucket there's nothing above to protect and a
      // lone collapsed bucket reads like the empty state, so render it flat/expanded.
      if (groups.high.length === 0 && groups.medium.length === 0) {
        elements.push({ tag: 'markdown', content: sectionTitle(meta, bucket.length) });
        elements.push(...lowItems(bucket, now, true));
      } else {
        elements.push(lowPanel(bucket, now));
      }
    } else {
      elements.push({ tag: 'markdown', content: sectionTitle(meta, bucket.length) });
      for (const it of bucket) elements.push(...itemBlock(it, now, { expandable: true }));
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
