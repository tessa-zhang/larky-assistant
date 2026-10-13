import { URGENCY_ORDER, URGENCY_META, BOT_SECTION_META, config } from './config.js';
import { formatDate, formatDateTime, relativeTime } from './time.js';
import { isAutomatedSender } from './fetchMentions.js';

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

/**
 * groupchat | DM | bot — `bot` wins over DM/groupchat. Reads the row's representative,
 * which is anchored to whoever addressed the user (fetchMentions.pickRepresentative), so
 * this label always agrees with the section the row was routed to.
 */
function chatType(item) {
  if (isAutomatedSender(item)) return 'bot';
  return item.isDM ? 'DM' : 'groupchat';
}

/** Action | FYI — the 5-way classify category collapsed to the binary that matters at a glance. */
function actionOrFyi(item) {
  return item.category === 'fyi' ? 'FYI' : 'Action';
}

/** Title format: <chat name> · <groupchat|DM|bot> · <Action|FYI>. */
function itemLabel(item) {
  // Prefer the resolved chat name; until bot capability is enabled it's null for
  // groups, so fall back to whoever sent the latest unread message.
  const name = item.chatName || item.senderName || (item.isDM ? 'Direct message' : 'Group chat');
  return `${name} · ${chatType(item)} · ${actionOrFyi(item)}`;
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
  // Directedness, shown so the ranking is auditable: the classifier weighs these signals
  // (2026-08-11) and this is how you check it's honouring them. `🎯 you only` = nobody
  // else tagged; otherwise `👥 you 2/5` = you were named 2nd of 5 people tagged.
  const tag = !item.isDM && item.myTagPosition
    ? (item.taggedCount === 1 ? ' · 🎯 you only' : ` · 👥 you ${item.myTagPosition}/${item.taggedCount}`)
    : '';
  const header = `**${item.n}.** ${meta.emoji} **[${md(itemLabel(item))}]**${broadcast}${tag}${ago ? ` · ${ago}` : ''}${atYou}${more}`;
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
 * Every item block for a bucket, in order — no display cap. Shared by the collapsed
 * panel and the expanded (only-bucket) render, for both LOW/FYI and the bot/app section.
 * Volume is already bounded upstream by MAX_MESSAGES, and each item carries a summary
 * worth reading, so hiding the tail behind an unreachable "+N more" only removed the
 * ability to act on it (2026-07-20). A bucket may still *collapse* — that's the panel's
 * job (R3); this just fills it completely.
 */
function bucketItems(bucket, now, expandable = false) {
  const inner = [];
  for (const it of bucket) inner.push(...itemBlock(it, now, { expandable }));
  return inner;
}

/**
 * A whole bucket as a collapsed `collapsible_panel` (the R3 pattern). The header
 * keeps the count so you see how many items are in there without expanding; ALL of
 * them live inside, revealed on demand (no cap). Used for LOW/FYI and for the
 * bot/app section — both are "keep it visible, keep it out of the way" buckets, so
 * they share one renderer. HIGH/MEDIUM are never collapsed (rendered flat by the caller).
 * `expandable:false` — no per-@ expander nested inside a panel (Lark 2.0 nested
 * collapsibles are unverified).
 */
function collapsedPanel(meta, bucket, now) {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: sectionTitle(meta, bucket.length) },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements: bucketItems(bucket, now, false),
  };
}

function digestTitle(variant, now) {
  const generatedLabel = formatDateTime(now);
  return variant === 'morning'
    ? `☀️ Your Morning Digest — ${generatedLabel.replace(/\s([ap]m)$/i, '$1')}`
    : `📋 Your Digest — ${generatedLabel}`;
}

/**
 * Build a Lark interactive card (schema 2.0) from numbered, classified items.
 * `items` must each carry: n, urgency, category, summary, chatName, isDM,
 * createTime, link.
 *
 * Sections, in reading order (matching `numberItems`' sort so numbering runs
 * monotonically down the card):
 *   - **human HIGH / MEDIUM** — rendered flat/expanded, the action list;
 *   - **human LOW/FYI** — collapsed behind a `collapsible_panel` (R3), or flat when
 *     it's the only bucket. Normally EMPTY: `runDigest` filters human lows out
 *     (action-only digest) and this path is kept for the R14 Catch Me Up brief;
 *   - **🤖 BOT / APP** — every bot/app item regardless of urgency, in its own collapsed
 *     panel at the bottom (2026-08-11). Automated pings stay visible without competing
 *     with human asks; the header count shows how many without expanding.
 */
export function buildDigestCard({ items, since, generatedAt = new Date(), footerHint, variant = 'standard' }) {
  const now = generatedAt;

  // Bot/app rows are pulled out FIRST — an automated row goes to the bot section
  // whatever it classified as, so it never lands in the human urgency buckets. The row's
  // sender is already anchored to whoever ADDRESSED the user rather than whoever spoke
  // last (fetchMentions.pickRepresentative), so a thread a colleague @'d the user in
  // reads as human here even if a bot @'d later — no genuine ask gets filed under bots.
  const groups = { high: [], medium: [], low: [] };
  const bots = [];
  for (const it of items) {
    if (isAutomatedSender(it)) bots.push(it);
    else (groups[it.urgency] || groups.low).push(it);
  }
  const humanCount = items.length - bots.length;

  // Nothing is filtered out any more (the action-only experiment was reverted the same
  // day), so the subtitle is a plain count again — no "N left out" note to keep honest.
  // Human and bot counts are split because they render as separate sections.
  const botNote = bots.length > 0 ? ` · ${bots.length} bot/app` : '';
  const elements = [
    { tag: 'markdown', content: `Showing **${humanCount}** mention${humanCount === 1 ? '' : 's'} & DM${humanCount === 1 ? '' : 's'} ${sinceText(since)}${botNote}` },
  ];

  for (const key of Object.keys(groups).sort((a, b) => URGENCY_ORDER[a] - URGENCY_ORDER[b])) {
    const bucket = groups[key];
    if (bucket.length === 0) continue;
    const meta = URGENCY_META[key];
    elements.push({ tag: 'hr' });
    if (key === 'low') {
      // LOW/FYI collapses behind a panel so it doesn't bury HIGH/MEDIUM (R3) — holding
      // EVERY low item (no cap). When LOW is the *only* human bucket there's nothing above
      // to protect and a lone collapsed bucket reads like the empty state, so render it
      // flat/expanded. (Unused while runDigest filters human lows out; kept for R14.)
      if (groups.high.length === 0 && groups.medium.length === 0) {
        elements.push({ tag: 'markdown', content: sectionTitle(meta, bucket.length) });
        elements.push(...bucketItems(bucket, now, true));
      } else {
        elements.push(collapsedPanel(meta, bucket, now));
      }
    } else {
      elements.push({ tag: 'markdown', content: sectionTitle(meta, bucket.length) });
      for (const it of bucket) elements.push(...itemBlock(it, now, { expandable: true }));
    }
  }

  if (bots.length > 0) {
    elements.push({ tag: 'hr' });
    // Same "visible but out of the way" treatment as LOW/FYI, and the same escape hatch:
    // when there's nothing human above it, a lone collapsed panel reads like the empty
    // state, so render the bot section flat instead of hiding the card's only content.
    if (humanCount === 0) {
      elements.push({ tag: 'markdown', content: sectionTitle(BOT_SECTION_META, bots.length) });
      elements.push(...bucketItems(bots, now, true));
    } else {
      elements.push(collapsedPanel(BOT_SECTION_META, bots, now));
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
      title: { tag: 'plain_text', content: digestTitle(variant, now) },
    },
    body: { elements },
  };
}
