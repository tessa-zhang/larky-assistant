import { URGENCY_ORDER, URGENCY_META, config } from './config.js';
import { formatDateTime, relativeTime } from './time.js';

/** Subtitle window phrase, e.g. "since Tue 16 Jun, 3:51 pm". */
function sinceText(windowStart) {
  return windowStart ? `since ${formatDateTime(windowStart)}` : 'recently';
}

// Escape lark_md control chars in untrusted text so summaries render literally.
function md(text) {
  return String(text || '').replace(/([\\*_~`\[\]])/g, '\\$1');
}

function itemLabel(item) {
  const name = item.chatName || (item.isDM ? 'Direct message' : 'group');
  return item.isDM ? `${name} · DM` : name;
}

function itemBlock(item, now) {
  const meta = URGENCY_META[item.urgency] || URGENCY_META.low;
  const ago = relativeTime(item.createTime, now);
  const header = `**${item.n}.** ${meta.emoji} **[${md(itemLabel(item))}]** · ${md(item.category)}${ago ? ` · ${ago}` : ''}`;
  const summary = `"${md(item.summary)}"`;
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `${header}\n${summary}` } },
  ];
  if (item.link) {
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '↗ Jump to message' }, type: 'primary', url: item.link },
      ],
    });
  }
  return elements;
}

/**
 * Build a Lark interactive card from numbered, classified items.
 * `items` must each carry: n, urgency, category, summary, chatName, isDM,
 * createTime, link.
 */
export function buildDigestCard({ items, since, generatedAt = new Date(), footerHint }) {
  const now = generatedAt;

  // Group by urgency, preserving the high→medium→low order.
  const groups = { high: [], medium: [], low: [] };
  for (const it of items) (groups[it.urgency] || groups.low).push(it);

  const elements = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `Showing **${items.length}** mention${items.length === 1 ? '' : 's'} & DM${items.length === 1 ? '' : 's'} ${sinceText(since)}` },
    },
  ];

  for (const key of Object.keys(groups).sort((a, b) => URGENCY_ORDER[a] - URGENCY_ORDER[b])) {
    const bucket = groups[key];
    if (bucket.length === 0) continue;
    const meta = URGENCY_META[key];
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `${meta.emoji} **${meta.label}**  (${bucket.length})` } });
    // Cap the LOW/FYI bucket so a noisy digest stays scannable.
    const limit = key === 'low' ? config.lowDisplayLimit : Infinity;
    const shown = bucket.slice(0, limit);
    for (const it of shown) elements.push(...itemBlock(it, now));
    if (bucket.length > shown.length) {
      elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `…+${bucket.length - shown.length} more low/FYI (use \`done\` to clear)` }] });
    }
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: footerHint || '↩ type `digest` to refresh' }],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `📋 Your Triage Digest — ${formatDateTime(now)}` },
    },
    elements,
  };
}
