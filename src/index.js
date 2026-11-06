import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { config, LARK_CLI_PROFILE, OWNER_OPEN_ID } from './config.js';
import { getSelf, assertIdentity, sendMessage } from './lark.js';
import { runDigest, runDone, runSnooze } from './commands.js';
import { currentSlotId, currentMorningDigestDate, localDateKey } from './scheduler.js';
import { registerUser, lookupUser, loadRegistry } from './users.js';
import { createKey } from './crypto.js';
import { runMorningDigestBatch } from './morningDigest.js';

const CLI_FOOTER = '↩ Run `npm run done 2` (or `-- all`) / `npm run snooze 1 3` · `npm run inlark` to refresh';
const BOT_FOOTER = '↩ Reply `done 2` (or `done all`) / `snooze 1 3` · type `n` to refresh';

// Welcome card we DM an unregistered sender. Shaped as a v2 interactive card
// (same schema as the digest) so the owner handoff lands as a real @mention
// rather than literal "@Yue Han Tessa Zhang" text — `<at id="…"></at>` in a
// markdown block resolves to a tappable chip in Lark. OWNER_OPEN_ID is the
// known-good open_id for larky's owner on this app (see config.js).
export const ONBOARDING_CARD = {
  schema: '2.0',
  config: { update_multi: true },
  header: {
    template: 'blue',
    title: { tag: 'plain_text', content: '👋 Welcome to Larky' },
  },
  body: {
    elements: [
      {
        tag: 'markdown',
        content:
          "Hello! I'm **Larky**, your personal assistant (soon-to-be!)\n\n" +
          "You're just one step away from accessing my services.\n\n" +
          `**To get onboarded**, please reach out to <at id="${OWNER_OPEN_ID}"></at> ` +
          'for an onboarding link so I know who you are and can deliver to you.\n\n' +
          '📖 Find out more in my [user guide](https://traveloka.sg.larksuite.com/wiki/PXJewhL6ui6yXMkscohl44rigud).',
      },
    ],
  },
};

// Lark API: app/identity is missing a required permission scope.
const LARK_ERROR_MISSING_SCOPE = 99991672;

function parseNumbers(args) {
  return args
    .join(' ')
    .split(/[\s,]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Delivery target + footer for one-shot CLI commands, based on SEND_AS. */
function cliDelivery(self) {
  if (config.sendAs === 'bot') {
    return { delivery: { as: 'bot', userId: self.openId }, footerHint: BOT_FOOTER };
  }
  return { delivery: { as: 'user', userId: self.openId }, footerHint: CLI_FOOTER };
}

/**
 * Resolve the acting user for a one-shot CLI command. Default: the owner
 * (`self`, as resolved at startup). `--user <open_id>` is a testing hook (R2
 * multi-user) that re-resolves identity under a registered non-owner user's
 * isolated HOME and hard-asserts it — lets you trigger a test digest for a
 * teammate from your own terminal without depending on their Lark client.
 */
async function resolveActingUser(self, args) {
  const i = args.indexOf('--user');
  if (i < 0) return self;
  const openId = args[i + 1];
  const entry = await lookupUser(openId);
  if (!entry) throw new Error(`--user ${openId}: not found in the registry. Run \`adduser\` first.`);
  const resolved = await getSelf(entry.home);
  assertIdentity(resolved, openId, `cli:--user ${openId}`);
  return { ...resolved, userName: entry.userName || resolved.userName };
}

async function cmdDigest(self, args = []) {
  const acting = await resolveActingUser(self, args);
  const { delivery, footerHint } = cliDelivery(acting);
  console.log(`Running digest (send as ${delivery.as}) for ${acting.userName}…`);
  const r = await runDigest({ self: acting, delivery, footerHint, ack: false });
  console.log(`Delivered: ${r.count} item(s).`, summarizeSkips(r.skipped));
}

/**
 * Register a non-owner user (R2 multi-user). Must be run AFTER you've
 * personally completed that user's device-flow consent under their own
 * isolated HOME (see SPEC.md's onboarding walkthrough) — this just records
 * the mapping, but only after proving the HOME actually resolves to the
 * open_id being registered (reuses the same hard-throw assertIdentity guard
 * that protects the owner at startup), so a typo'd open_id/home pair can
 * never silently enter the registry.
 */
async function cmdAddUser(args) {
  const [openId, home, ...rest] = args;
  if (!openId || !home) return console.error('Usage: npm run adduser -- <open_id> <home-path> [userName]');
  const userName = rest.join(' ').trim() || null;
  const resolved = await getSelf(home);
  assertIdentity(resolved, openId, 'adduser');
  await registerUser(openId, home, userName || resolved.userName);
  console.log(`Registered ${userName || resolved.userName} (${openId}) -> ${home}`);
}

async function cmdListUsers() {
  const registry = await loadRegistry();
  const entries = Object.entries(registry);
  if (!entries.length) return console.log('No registered users yet. Run `adduser` to add one.');
  for (const [openId, e] of entries) {
    console.log(`${e.userName || '(no name)'}  ${openId}  -> ${e.home}  (added ${e.addedAt})`);
  }
}

function reportMorningResults(dateKey, results) {
  for (const result of results) {
    const label = result.openId || 'registry';
    if (result.status === 'sent') {
      console.log(`[morning] ${dateKey} — sent to ${label} (${result.count} item(s))`);
    } else if (result.status === 'already-sent') {
      console.log(`[morning] ${dateKey} — already sent to ${label}`);
    } else if (result.status === 'busy') {
      console.log(`[morning] ${dateKey} — ${label} busy; will retry`);
    } else if (result.status === 'degraded') {
      console.log(`[morning] ${dateKey} — ${label} classification unavailable; retrying in 5 minutes within the morning window`);
    } else if (result.status === 'retry-later') {
      // A degraded run is cooling down; no repeated log line on every minute tick.
      continue;
    } else {
      console.error(`[morning] ${dateKey} — ${label} failed: ${result.error?.message || result.status}`);
    }
  }
}

async function cmdMorning(self) {
  const dateKey = localDateKey(new Date());
  const results = await runMorningDigestBatch({
    owner: self,
    dateKey,
    digestsInFlight: new Set(),
    footerHint: BOT_FOOTER,
  });
  reportMorningResults(dateKey, results);
}

/**
 * Mint a fresh state-encryption key, overwriting the Keychain entry (R17 recovery
 * path — see src/crypto.js). Use when Keychain reports a malformed/unreadable key
 * on boot: every existing user's encrypted lastDigest becomes unreadable (next
 * `npm run inlark` rebuilds from Lark — no core state is lost, just the pending
 * `done`/`snooze` number mapping). Confirmation-gated so a stray `npm run reset-key`
 * can't quietly rotate the key.
 */
async function cmdResetKey(args) {
  if (!args.includes('--yes')) {
    console.error(
      'This will OVERWRITE the state-encryption key in Keychain. Every pending digest\n' +
      '(the lastDigest in state/*.json) will become unreadable — `done 2` / `snooze 3`\n' +
      'will not work until the next `npm run inlark` rebuilds them from Lark.\n' +
      'No core state is lost (doneMessageIds, snoozedMessages, timestamps all survive).\n' +
      '\n' +
      'If this is really what you want, re-run with --yes:\n' +
      '  npm run reset-key -- --yes',
    );
    process.exit(1);
  }
  await createKey();
  console.log('✓ New state-encryption key generated and stored in Keychain.');
  console.log('  Pending digests are now unreadable — run `npm run inlark` to rebuild.');
}

async function cmdDone(self, args) {
  const all = /^all$/i.test(args.join(' ').trim());
  const numbers = all ? null : parseNumbers(args);
  if (!all && !numbers.length) return console.error('Usage: npm run done -- 2 3   (or: all)');
  const { delivery, footerHint } = cliDelivery(self);
  const r = await runDone({ userId: self.openId, delivery, footerHint, numbers, all });
  console.log(`Done: ${r.affected} item(s).`);
}

async function cmdSnooze(self, args) {
  const numbers = parseNumbers(args);
  if (!numbers.length) return console.error('Usage: npm run snooze -- 1 3');
  const { delivery, footerHint } = cliDelivery(self);
  const r = await runSnooze({ userId: self.openId, delivery, footerHint, numbers });
  console.log(`Snoozed: ${r.affected} item(s).`);
}

function summarizeSkips(s) {
  if (!s) return '';
  const parts = [];
  if (s.read) parts.push(`${s.read} already-read (replied-since)`);
  if (s.reacted) parts.push(`${s.reacted} reacted (addressed)`);
  if (s.automated) parts.push(`${s.automated} bot/app`);
  if (s.hidden) parts.push(`${s.hidden} hidden`);
  if (s.empty) parts.push(`${s.empty} empty/deleted`);
  if (s.excludedChat) parts.push(`${s.excludedChat} excluded-channel`);
  if (s.capped) parts.push(`${s.capped} capped (raise MAX_MESSAGES)`);
  return parts.length ? `Skipped: ${parts.join(', ')}.` : '';
}

/**
 * WebSocket listener: the bot receives DMs and reacts to `n` / `done N` /
 * `snooze N`. Requires bot send scopes + a published app (see README).
 */
async function cmdListen(self) {
  const pollNote = config.pollEnabled
    ? ` Auto-poll every ${config.poll.intervalMinutes}m, ${config.poll.startHour}:00–${config.poll.endHour}:00${config.poll.weekdaysOnly ? ' weekdays' : ''}.`
    : '';
  const morningNote = config.morningDigestEnabled
    ? ` Morning digest at ${config.morningDigest.time} (wake catch-up until ${config.morningDigest.cutoff}${config.morningDigest.weekdaysOnly ? ', weekdays' : ''}).`
    : '';
  console.log(`Listening for commands from ${self.userName} (DM the bot: "n")… Ctrl+C to stop.${pollNote}${morningNote}`);
  // --profile pins this to our app regardless of lark-cli's global active profile
  // (see LARK_CLI_PROFILE in config.js) — this call bypasses lark.js's runRaw, so
  // it needs the same pin applied separately.
  //
  // No per-user HOME override here (R2 multi-user): this is the BOT identity
  // (`--as bot`), which is app-level/tenant-scoped and shared across every
  // user's digest/send — unlike the per-user READ calls in lark.js, which do
  // thread an isolated HOME per sender (see cmdListen's dispatch resolution
  // below + runRaw in lark.js). See SPEC.md.
  const child = spawn('lark-cli', ['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--profile', LARK_CLI_PROFILE], {
    stdio: ['pipe', 'pipe', 'pipe'], // keep stdin open so the unbounded run doesn't EOF-exit
  });

  // Block until the ready marker, then surface stderr diagnostics.
  child.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line.includes('[event] ready')) console.log('✓ event bus ready');
    else if (line) console.error('[event]', line);
  });

  const seen = new Set();
  // In-flight guard for the heavy digest pipeline, keyed by acting user's
  // open_id. A digest's burst (watermark + mention + DM searches + reactions)
  // runs against ONE user's token, so the 99991400 risk is per-user — a
  // concurrent digest for a *different* user hits a different HOME/token and
  // can proceed. Dropping a cross-user trigger as a "duplicate" was a bug
  // (reported live: Yixin's `n` silently ignored while Tessa's was running).
  // Misrouting is already prevented upstream: `actingUser` is re-resolved +
  // assertIdentity'd fresh per message, before this guard runs.
  const digestsInFlight = new Set();

  // R12 auto-poll: checked every 60s against a computed "current slot id" rather
  // than a naive setInterval(fn, intervalMs) from process-start, so it's
  // wall-clock aligned (fires at e.g. 10:00/14:00/18:00 regardless of when
  // `listen` started), never double-fires a slot, and self-recovers from the
  // laptop sleeping through one (fires once for whichever slot is current on
  // wake — no backlog replay). Shares `digestsInFlight` with the manual `n`
  // trigger so a scheduled tick and a manual one for the SAME user can never
  // overlap and trip Lark's back-to-back rate limit (99991400 — see SPEC's
  // limitations table). Keyed by owner's open_id since this poll runs the
  // owner's digest only.
  let lastFiredSlot = null;
  setInterval(async () => {
    if (!config.pollEnabled) return;
    const slot = currentSlotId(new Date(), config.poll);
    if (!slot || slot === lastFiredSlot) return;
    lastFiredSlot = slot;
    if (digestsInFlight.has(self.openId)) { console.log(`[poll] ${slot} — skip, owner's digest already running`); return; }
    digestsInFlight.add(self.openId);
    try {
      const delivery = config.sendAs === 'bot' ? { as: 'bot', userId: self.openId } : { as: 'user', userId: self.openId };
      const r = await runDigest({ self, delivery, footerHint: BOT_FOOTER, ack: false, requireChange: true });
      console.log(r.sent === false ? `[poll] ${slot} — no changes, skipped` : `[poll] ${slot} — sent (${r.count} item(s))`);
    } catch (err) {
      console.error('[poll] failed:', err.message);
    } finally {
      digestsInFlight.delete(self.openId);
    }
  }, 60_000);

  // One full morning digest per user and local calendar day. A sleeping laptop
  // simply pauses this timer; on wake, the first tick inside the catch-up window
  // runs the cohort sequentially. Completion is also persisted per user, so a
  // listener restart cannot duplicate a successful send.
  let activeMorningDate = null;
  let morningBatchRunning = false;
  const completedMorningUsers = new Set();
  const runMorningSchedulerTick = async () => {
    if (!config.morningDigestEnabled || morningBatchRunning) return;
    let dateKey;
    try {
      dateKey = currentMorningDigestDate(new Date(), config.morningDigest);
    } catch (error) {
      console.error('[morning] invalid schedule:', error.message);
      return;
    }
    if (!dateKey) return;
    if (dateKey !== activeMorningDate) {
      activeMorningDate = dateKey;
      completedMorningUsers.clear();
    }

    morningBatchRunning = true;
    try {
      const results = await runMorningDigestBatch({
        owner: self,
        dateKey,
        digestsInFlight,
        footerHint: BOT_FOOTER,
        completedUserIds: completedMorningUsers,
      });
      for (const result of results) {
        if (result.openId && ['sent', 'already-sent'].includes(result.status)) {
          completedMorningUsers.add(result.openId);
        }
      }
      reportMorningResults(dateKey, results);
    } finally {
      morningBatchRunning = false;
    }
  };
  const scheduleMorningTick = () => {
    void runMorningSchedulerTick().catch((error) => {
      console.error('[morning] scheduler failed:', error.message);
    });
  };
  scheduleMorningTick();
  setInterval(scheduleMorningTick, 60_000);

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', async (line) => {
    if (!line.trim().startsWith('{')) return;
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    const e = evt.event || evt;

    // Only a 1:1 chat with the bot — sender is either the owner or a registered
    // non-owner user (R2 multi-user; see users.js).
    const senderId = e.sender_id?.open_id || e.sender_id || e.sender?.id;
    const chatType = e.chat_type || e.message?.chat_type;
    const chatId = e.chat_id || e.message?.chat_id;
    const messageId = e.message_id || e.message?.message_id;
    let text = e.content ?? e.message?.content ?? '';
    if (chatType !== 'p2p') return;
    if (messageId && seen.has(messageId)) return;
    if (messageId) seen.add(messageId);

    // Resolve the acting identity for this sender. The owner uses the startup-
    // resolved `self` (ambient HOME) unchanged. Anyone else must be in the
    // registry AND re-verified fresh under their own isolated HOME on every
    // single dispatch — never cached across messages — so a stale/misconfigured
    // registry entry fails loudly (into the catch below, nothing sent) instead
    // of ever running one user's digest under another user's token. This is the
    // standing red line: never let larky pull another user's token for a digest
    // meant for someone else, or vice versa. See SPEC.md.
    let actingUser = self;
    if (senderId !== self.openId) {
      const entry = await lookupUser(senderId);
      if (!entry) {
        // Unregistered sender: reply once per inbound message with the onboarding
        // handoff card, so a stranger isn't met with silence. Best-effort — a
        // send failure here must never crash the listener.
        try {
          await sendMessage({ as: 'bot', chatId, content: ONBOARDING_CARD, msgType: 'interactive' });
        } catch (err) {
          console.error('Onboarding reply failed:', err.message);
        }
        return;
      }
      try {
        const resolved = await getSelf(entry.home);
        assertIdentity(resolved, senderId, `listen-dispatch:${senderId}`);
        actingUser = { ...resolved, userName: entry.userName || resolved.userName };
      } catch (err) {
        console.error('Dispatch identity check failed:', err.message);
        return;
      }
    }

    // content for text messages is decoded to plain text; tolerate JSON too.
    if (typeof text === 'string' && text.trim().startsWith('{')) {
      try { text = JSON.parse(text).text ?? text; } catch { /* keep */ }
    }
    const cmd = String(text).trim();
    const delivery = { as: 'bot', chatId };

    // Per-request log line — identifies which profile is handling this request
    // so a server-side tail shows at a glance who is doing what (and makes
    // cross-user issues like duplicate-trigger drops obvious). Open_id only,
    // no display name — the log file isn't a PII surface.
    const who = actingUser === self ? 'owner' : 'guest';
    console.log(`[req] ${who} <${actingUser.openId}> → ${JSON.stringify(cmd).slice(0, 80)}`);

    try {
      if (/^n$/i.test(cmd)) {
        // A digest is a burst of Lark calls (watermark + mention + DM searches, then
        // chat-name + reaction lookups) against ONE user's token. A second `n` from
        // the SAME user before the first returns doubles that burst and trips Lark's
        // rate limit (99991400). Ignore overlapping triggers from that user — the
        // first run's "⏳ Fetching…" ack already signals it's working. Keyed per
        // user: a different user's `n` hits a different HOME/token and proceeds.
        if (digestsInFlight.has(actingUser.openId)) { console.error(`digest already running for ${actingUser.openId} — ignoring duplicate trigger`); return; }
        digestsInFlight.add(actingUser.openId);
        try {
          await runDigest({ self: actingUser, delivery, footerHint: BOT_FOOTER, ack: true });
        } finally {
          digestsInFlight.delete(actingUser.openId);
        }
      } else if (/^done\b/i.test(cmd)) {
        const rest = cmd.replace(/^done/i, '').trim();
        const all = /^all$/i.test(rest);
        // State is keyed by the acting user (the DM sender), so done/snooze read+write
        // that user's own digest snapshot — never another user's. No Lark reads here
        // (only sendMessage, which is bot-identity), so no HOME threading needed.
        await runDone({ userId: senderId, delivery, footerHint: BOT_FOOTER, all, numbers: all ? null : parseNumbers([rest]) });
      } else if (/^snooze\b/i.test(cmd)) {
        await runSnooze({ userId: senderId, delivery, footerHint: BOT_FOOTER, numbers: parseNumbers([cmd.replace(/^snooze/i, '')]) });
      }
    } catch (err) {
      console.error('Command failed:', err.message);
      if (err.larkError) console.error('  →', JSON.stringify(err.larkError));
    }
  });

  child.on('exit', (code) => {
    console.error(`event consumer exited (code ${code}). Restart \`npm run listen\`.`);
    process.exit(code || 0);
  });
  const shutdown = () => { try { child.stdin.end(); } catch {} setTimeout(() => child.kill('SIGTERM'), 200); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const cmd = (command || 'digest').toLowerCase();

  // reset-key is the recovery path for a broken Keychain entry (R17) — it must
  // work even when Lark auth itself is sideways, so skip the identity check for it.
  if (cmd === 'reset-key') return cmdResetKey(args);

  const self = await getSelf();
  try {
    assertIdentity(self, config.userOpenId || OWNER_OPEN_ID, 'startup');
  } catch (err) {
    // Best-effort alert so a stopped/misrouted `listen` doesn't go unnoticed for
    // days (R12: unattended). Never let this mask or replace the original error.
    try {
      await sendMessage({ as: 'bot', userId: OWNER_OPEN_ID, content: `⚠️ inlark refused to start: ${err.message}` });
    } catch { /* best-effort only */ }
    throw err;
  }

  switch (cmd) {
    case 'digest': return cmdDigest(self, args);
    case 'done': return cmdDone(self, args);
    case 'snooze': return cmdSnooze(self, args);
    case 'listen': return cmdListen(self);
    case 'morning': return cmdMorning(self);
    case 'adduser': return cmdAddUser(args);
    case 'listusers': return cmdListUsers();
    default:
      console.error(`Unknown command: ${command}\nUsage: digest [--user <open_id>] | morning | done <n…> | snooze <n…> | listen | adduser <open_id> <home> [name] | listusers | reset-key --yes\n  (npm scripts: npm run inlark [-- --user <id>] | npm run morning | npm run done -- <n…> | npm run snooze -- <n…> | npm run listen | npm run adduser -- <open_id> <home> [name] | npm run listusers | npm run reset-key -- --yes)`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  if (err.larkError?.code === LARK_ERROR_MISSING_SCOPE) {
    console.error('→ Missing Lark scope. See README "Enabling the bot".');
  }
  process.exit(1);
});
