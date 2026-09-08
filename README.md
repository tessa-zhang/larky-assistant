# Lark Triage Bot

An on-demand triage assistant for Lark. It scans your **unread @mentions** (group
chats) and **unread DMs** (1:1 chats), classifies each by urgency with Claude,
and delivers a prioritised **interactive card** — one row per chat, each showing
the AI summary **plus the exact message text** and a deep link to jump straight
to it — so you can triage without opening (and thereby reading) the chat. Anything
you've **replied to or reacted to** is treated as handled and won't reappear, and
**@all** blasts are flagged and down-ranked. Plus `done` / `snooze` to keep the
list clean.

> See **[SPEC.md](SPEC.md)** for the authoritative requirements, the definition
> of "unread" (a reply-watermark proxy — Lark exposes no real read-state), and
> the discovered API constraints.

## How this differs from the original spec

This build targets the **`lark-cli` toolchain** already configured on this
machine, which changes the plumbing (the user experience is unchanged):

| Spec | This build | Reason |
|---|---|---|
| express + public `/webhook` | `lark-cli event consume` over WebSocket | No public URL needed |
| node-sdk + manual token mgmt | shell out to `lark-cli` | lark-cli owns auth + token refresh |
| tappable Done/Snooze buttons | `done 2` / `snooze 1 3` **text commands** | The WebSocket event bus delivers no card-action callbacks |
| patch card in place | re-render + resend a fresh card | lark-cli exposes no message-patch method |
| base64-decode `content` | not needed | lark-cli returns decoded plain text |
| guess `message/open?msgId=` deep link | use the `message_app_link` Lark returns | Verified, version-proof |

## Two run modes

### 1. Interim path — works today, no console changes

Delivers the digest to **your own self-chat** using **your** identity. Trigger
it from the terminal.

```bash
SEND_AS=user        # default
npm run inlark      # fetch + classify + deliver card to your self-chat
npm run done -- 2 3 # mark items 2 and 3 done, re-render
npm run snooze -- 1 # snooze item 1 for 24h, re-render
```

### 2. Full bot path — `n` keyword trigger

The bot replies in its DM thread when you type `n` (for "new"), and accepts
`done N` / `snooze N` replies. Requires the console setup below, then:

```bash
SEND_AS=bot
npm run listen      # long-running WebSocket listener
# then DM the bot in Lark: "n"
```

## Setup

```bash
npm install
cp .env.example .env   # then set ANTHROPIC_API_KEY
```

Lark auth is already handled by `lark-cli` (run `lark-cli auth status` to
confirm your user identity is `ready`). No Lark secrets live in `.env`.

## Enabling the bot (one-time console steps)

The interim path needs nothing. The **full bot path** is currently blocked
because the bot (tenant) identity lacks send scopes. In the
[Lark Developer Console](https://open.larksuite.com) for app
`cli_a97b3f76a9a3ded4`:

1. **Add the Bot capability** (Features → Bot) — resolves error `232025
   "Bot ability is not activated"`.
2. **Grant bot scopes**: `im:message:send_as_bot`, `im:message`
   (and optionally `im:chat:readonly` so group **chat names** resolve for the
   `[label]` and the channel-exclusion list).
3. **Publish a new app version** — bot-token scopes only take effect once a
   version is released and approved.
4. Make sure the bot is available to you and you have a DM open with it.

Verify with:

```bash
lark-cli im +messages-send --as bot --user-id <your_open_id> --text "ping"
```

When that succeeds, set `SEND_AS=bot` and run `npm run listen`.

## Commands

| Command | Action |
|---|---|
| `npm run inlark` | Fetch currently-unread mentions+DMs (last 7 days), classify, deliver card |
| `npm run done -- <n…>` | Mark card items done (never reappear) |
| `npm run snooze -- <n…>` | Hide items for `SNOOZE_HOURS` (default 24h) |
| `npm run listen` | Bot mode: react to `n` / `done` / `snooze` DMs |

## How it works

```
src/
├── index.js        # CLI dispatch + WebSocket listener
├── config.js       # constants, noise-exclusion patterns
├── state.js        # state.json: lastRun, done, snooze, last-digest snapshot
├── lark.js         # lark-cli exec wrapper
├── fetchMentions.js# messages-search: unread @mentions (group) + DMs (p2p), one row per chat
├── classify.js     # chunked Claude calls (40/call, concurrent) → urgency/category/summary
├── buildCard.js    # Lark interactive card JSON
└── commands.js     # digest / done / snooze orchestration
```

- **Fetching** uses `messages-search --is-at-me` (group) and `--chat-type p2p`
  (DMs), both with `--exclude-sender-type bot`. `app` senders (release cards,
  alert apps, Slack mirrors) slip past that flag, so they're dropped client-side
  too. Results are then collapsed to **one row per chat** (latest unread, with a
  `+N more` hint), mirroring Lark's "@ Mentions" tab.
- **Unread filter** (reply-watermark): a third `--sender <me>` search builds a
  per-chat watermark (my latest `message_position`); any mention/DM at or before
  it is treated as already-read and dropped. Thread replies arrive as the sentinel
  `message_position = "-3"`, which is treated as *uncomparable ⇒ unread* (a naive
  compare would wrongly drop ~half of @mentions). Lark has no read-state API, so
  this is the proxy. See [SPEC.md](SPEC.md).
- **Reaction filter** (also = addressed): messages I've **reacted to** (any emoji)
  are dropped too — `reactions batch_query` matched on my `open_id`. Reactions
  *are* readable even though read-state isn't, so a 👍/✅ "got it" clears an item
  without a reply.
- **@all vs @me**: `--is-at-me` also returns **@all** blasts (Lark counts @all as
  "at me"). A direct ping lists my `open_id` in `mentions[]`; an @all doesn't — so
  @all items are kept but tagged **`📣 @all`** and biased toward low/fyi.
- **Each card item** shows the AI summary **and the verbatim message** (truncated
  to ~2 lines) so you can triage without opening the chat — which would mark it
  read in Lark.
- **`done` / `snooze`** re-render from a cached snapshot of the last digest
  (`state.lastDigest`), so they're instant — no re-fetch or re-classify.
- **Fixed window**: every run scans the last `LOOKBACK_HOURS` (default 168h / 7
  days) for *currently-unread* items — running a digest doesn't read anything, so
  re-running re-surfaces the same backlog until you reply, `done`, or `snooze` it.
  It's a *rolling* window, so items eventually slide off the far edge (a stable
  weekly anchor is a parked follow-up — see the spec's R8).

## State (`state.json`, auto-created)

```json
{
  "lastRunAt": "2026-06-15T09:00:00.000Z",
  "doneMessageIds": ["om_abc123"],
  "snoozedMessages": [{ "messageId": "om_xyz789", "snoozeUntil": "2026-06-16T09:00:00.000Z" }],
  "lastDigest": { "generatedAt": "…", "since": "…", "items": [ /* numbered, classified */ ] }
}
```

## Notes & limitations

- **Group chat names + name-based channel exclusion** require bot capability +
  `im:chat:readonly`; until then group items show `[group]` and the
  `--exclude-sender-type bot` filter carries the noise reduction.
- **Privacy**: message text is sent to the Anthropic API for classification.
  Confirm this is acceptable for internal content before wider use.
  `ANTHROPIC_BASE_URL` can redirect that to an Anthropic-compatible gateway —
  leave it unset unless IT/Security has approved the target for company data.
  A non-default endpoint is logged on every run.
- `MAX_MESSAGES` caps a single run as a rate-limit guard; the CLI reports when
  items were capped.
