import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { config } from './config.js';
import { getSelf } from './lark.js';
import { runDigest, runDone, runSnooze } from './commands.js';

const CLI_FOOTER = '↩ Run `npm run done 2` / `npm run snooze 1 3` · `npm run digest` to refresh';
const BOT_FOOTER = '↩ Reply `done 2` or `snooze 1 3` · type `digest` to refresh';

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

async function cmdDigest(self) {
  const { delivery, footerHint } = cliDelivery(self);
  console.log(`Running digest (send as ${delivery.as}) for ${self.userName}…`);
  const r = await runDigest({ self, delivery, footerHint, ack: false });
  console.log(`Delivered: ${r.count} item(s).`, summarizeSkips(r.skipped));
}

async function cmdDone(self, args) {
  const numbers = parseNumbers(args);
  if (!numbers.length) return console.error('Usage: npm run done -- 2 3');
  const { delivery, footerHint } = cliDelivery(self);
  const r = await runDone({ delivery, footerHint, numbers });
  console.log(`Done: ${r.done} item(s).`);
}

async function cmdSnooze(self, args) {
  const numbers = parseNumbers(args);
  if (!numbers.length) return console.error('Usage: npm run snooze -- 1 3');
  const { delivery, footerHint } = cliDelivery(self);
  const r = await runSnooze({ delivery, footerHint, numbers });
  console.log(`Snoozed: ${r.snoozed} item(s).`);
}

function summarizeSkips(s) {
  if (!s) return '';
  const parts = [];
  if (s.read) parts.push(`${s.read} already-read (replied-since)`);
  if (s.hidden) parts.push(`${s.hidden} hidden`);
  if (s.empty) parts.push(`${s.empty} empty/deleted`);
  if (s.excludedChat) parts.push(`${s.excludedChat} excluded-channel`);
  if (s.capped) parts.push(`${s.capped} capped (raise MAX_MESSAGES)`);
  return parts.length ? `Skipped: ${parts.join(', ')}.` : '';
}

/**
 * WebSocket listener: the bot receives DMs and reacts to `digest` / `done N` /
 * `snooze N`. Requires bot send scopes + a published app (see README).
 */
async function cmdListen(self) {
  console.log(`Listening for commands from ${self.userName} (DM the bot: "digest")… Ctrl+C to stop.`);
  const child = spawn('lark-cli', ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
    stdio: ['pipe', 'pipe', 'pipe'], // keep stdin open so the unbounded run doesn't EOF-exit
  });

  // Block until the ready marker, then surface stderr diagnostics.
  child.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line.includes('[event] ready')) console.log('✓ event bus ready');
    else if (line) console.error('[event]', line);
  });

  const seen = new Set();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', async (line) => {
    if (!line.trim().startsWith('{')) return;
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    const e = evt.event || evt;

    // Only the owner, only in a 1:1 chat with the bot.
    const senderId = e.sender_id?.open_id || e.sender_id || e.sender?.id;
    const chatType = e.chat_type || e.message?.chat_type;
    const chatId = e.chat_id || e.message?.chat_id;
    const messageId = e.message_id || e.message?.message_id;
    let text = e.content ?? e.message?.content ?? '';
    if (chatType !== 'p2p' || senderId !== self.openId) return;
    if (messageId && seen.has(messageId)) return;
    if (messageId) seen.add(messageId);

    // content for text messages is decoded to plain text; tolerate JSON too.
    if (typeof text === 'string' && text.trim().startsWith('{')) {
      try { text = JSON.parse(text).text ?? text; } catch { /* keep */ }
    }
    const cmd = String(text).trim();
    const delivery = { as: 'bot', chatId };

    try {
      if (/^digest$/i.test(cmd)) {
        await runDigest({ self, delivery, footerHint: BOT_FOOTER, ack: true });
      } else if (/^done\b/i.test(cmd)) {
        await runDone({ delivery, footerHint: BOT_FOOTER, numbers: parseNumbers([cmd.replace(/^done/i, '')]) });
      } else if (/^snooze\b/i.test(cmd)) {
        await runSnooze({ delivery, footerHint: BOT_FOOTER, numbers: parseNumbers([cmd.replace(/^snooze/i, '')]) });
      }
    } catch (err) {
      console.error('Command failed:', err.message);
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
  const self = await getSelf();
  if (config.userOpenId) self.openId = config.userOpenId;

  switch ((command || 'digest').toLowerCase()) {
    case 'digest': return cmdDigest(self);
    case 'done': return cmdDone(self, args);
    case 'snooze': return cmdSnooze(self, args);
    case 'listen': return cmdListen(self);
    default:
      console.error(`Unknown command: ${command}\nUsage: digest | done <n…> | snooze <n…> | listen`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  if (err.larkError?.code === 99991672) {
    console.error('→ Missing Lark scope. See README "Enabling the bot".');
  }
  process.exit(1);
});
