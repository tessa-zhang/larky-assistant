# Lark Triage Bot — Spec (v2, living)

> Supersedes the original `lark-triage-bot-spec.md`. This version reflects
> decisions made during build + the real constraints of the Lark API and the
> `lark-cli` toolchain. Where v1 and v2 disagree, **v2 wins**.

---

## Goal

On demand, surface **everything addressed to me that I haven't dealt with yet**
— my **unread @mentions** and **unread DMs** — classify them by urgency with AI,
and deliver one prioritised, interactive digest card I can act on (jump / done /
snooze). Read/handled chatter must not appear.

## User story

> "When I trigger a digest, I get only my **unread** @mentions and DMs —
> not stuff I've already read or replied to. Each item has an AI summary, an
> urgency label, and a jump link. I clear items with `done` / `snooze`."

---

## What counts as "unread" (READ THIS — it's the crux)

**Lark exposes no unread signal via its API.** Verified across the messaging
*and* feed (消息流) modules:

- Messages carry **no read/unread field** (`messages-search`, `chat-messages-list`).
- The only read APIs are *who read a message **I** sent* (`read_users`, the
  `message_read` event, batch read counts) — useless for *my* received messages.
- The Feed module's APIs only let an app **write cards into** the feed; none
  return the feed's **unread counts / badges**. The badge is computed
  client-side and never returned by the API.
- Therefore "take the badge count and count backwards" is **not implementable** —
  we cannot read the badge. No permission scope unlocks this.

So "unread" is **approximated** by a behavioural proxy, applied to **both DMs
and @mentions**:

### The reply-watermark rule

> For each chat, find the `message_position` of **my most recent message** in
> that chat (the *watermark*). A candidate message is **unread** if its
> `message_position` is **greater than** the watermark. If I have no message in
> that chat (within the watermark lookback), all candidates there are treated as
> unread.

Rationale: if I posted *after* a message, I've necessarily read it. `message_position`
is a per-chat monotonic sequence, so this ordering is exact (more reliable than
the minute-granularity `create_time`).

**Layered with two more filters**, an item is shown only if ALL hold:
1. **Unread** by the watermark rule (above).
2. **Not** in `doneMessageIds` and **not** currently snoozed.
3. Within the **lookback window** — capped at `LOOKBACK_HOURS` (default **24h**):
   `start = later of (last-digest time, now − 24h)`, so no run ever pulls a large
   backlog of older, likely-already-read items.

**Known blind spot (irreducible):** a message I *read but never replied to*
(e.g. a "sureee" closer, or a group @mention I read silently) will appear once.
I clear it with `done`, or it ages out of the window. This is the unavoidable
cost of Lark having no read API.

---

## Fetching (user identity, via `lark-cli`)

All times are ISO 8601 with a **numeric offset, no milliseconds**
(`2026-06-16T05:00:00+00:00`) — `.sssZ` fails with error `99992402`.

```bash
# 1. Unread @mentions  (Lark's "@ Mentions" tab == --is-at-me)
lark-cli im +messages-search --as user --is-at-me --chat-type group \
  --start <LOOKBACK> --exclude-sender-type bot --page-all --json

# 2. DMs (p2p) — note: NOT --is-at-me; returns my own messages too (needed for watermark)
lark-cli im +messages-search --as user --chat-type p2p \
  --start <LOOKBACK> --exclude-sender-type bot --page-all --json

# 3. Reply watermark — my own recent messages everywhere, in one call
lark-cli im +messages-search --as user --sender <SELF_OPEN_ID> \
  --start <WATERMARK_LOOKBACK 14d> --page-all --json
#   → build map: chat_id -> max(message_position) of my messages
```

`content` is already decoded plain text. Each message has `message_id`,
`chat_id`, `message_position`, `create_time`, `sender{id,name,sender_type}`,
`mentions[]`, and **`message_app_link`** (use verbatim for the Jump button).

### Filtering after fetch
- Apply the **watermark rule** to mentions **and** DMs.
- Drop my own messages (`sender.id == SELF`).
- Drop `done`/snoozed; drop `deleted`; drop messages with **no meaningful text**
  after stripping placeholders (`[Sticker]`, `[Image: …]`, `[File: …]`, …).
- Drop known **noise channels** by name *when resolvable* (`unbookable-item-alert-*`,
  `cross-sell-null-item-alert-*`, `merchandising_oncall`, `release-and-hotfix`,
  `promo-error-report`, `*| Slack`). Name resolution needs bot capability +
  `im:chat:readonly`; until then, `--exclude-sender-type bot` carries it.
- Dedupe by `message_id`.

---

## AI classification

Each surviving message → `urgency` (high|medium|low), `category`
(incident|decision_needed|review_request|question|fyi), and a ≤15-word `summary`
focused on what the sender needs. Definitions unchanged from v1. In the
**agent-driven skill** the agent classifies inline; in the **Node app** a
chunked Claude call (`claude-sonnet-4-6`, ≤40 msgs/call) does it, with a
low/fyi fallback so nothing is dropped.

---

## Digest card

Lark interactive card. Grouped 🔴 HIGH / 🟡 MEDIUM / 🟢 LOW, **items numbered
1..N globally** (numbers are how `done`/`snooze` reference items). Each item:
label `[chat or sender · DM]`, category, relative time, quoted summary, and a
`↗ Jump to message` URL button. LOW bucket capped (~10) with a "+N more" note.
Empty state → `✅ You're all caught up!`.

---

## Done / Snooze (text commands)

There are **no card-button callbacks** over the lark-cli WebSocket event bus, so
management is by text reply referencing the card numbers:

- `done 2 3` → add to `doneMessageIds`; never resurface.
- `snooze 1` → hide for `SNOOZE_HOURS` (default 24h), then resurface if still unread.

lark-cli has **no message-patch** method, so the card is **re-rendered and
resent** (not edited in place); survivors are renumbered.

---

## State (`~/.lark-triage/state.json` for the skill; `./state.json` for the app)

```json
{
  "lastRunAt": "2026-06-16T09:00:00.000Z",
  "doneMessageIds": ["om_abc"],
  "snoozedMessages": [{ "messageId": "om_xyz", "snoozeUntil": "2026-06-17T09:00:00.000Z" }],
  "lastDigest": { "generatedAt": "…", "since": "…",
    "items": [ { "n": 1, "message_id": "…", "chat_id": "…", "urgency": "…",
                 "category": "…", "summary": "…", "link": "…", "sender": "…",
                 "create_time": "…", "is_dm": false } ] }
}
```

`lastDigest.items` is the snapshot `done`/`snooze` act on **without re-fetching**.

---

## Architecture & delivery (decided during build)

- **Trigger / events:** `lark-cli event consume im.message.receive_v1` over the
  WebSocket long-connection — **no public webhook URL**. (Bot mode.)
- **All Lark calls:** shell out to `lark-cli`; it owns token storage + refresh.
- **Send identity:** `SEND_AS=user` → digest to my **self-chat** (works today);
  `SEND_AS=bot` → bot replies in its DM (needs bot scopes + published version).
- Two delivery forms of the same logic: the **`lark-triage` skill** (agent
  classifies inline, on-demand) and the **Node app** (`npm run digest|listen`,
  unattended/scheduled).

## Lark API limitations discovered (so we don't relitigate)

| Want | Reality |
|---|---|
| True unread / read state | **Not exposed** by any Lark API (messaging or feed) |
| Unread badge / count per chat | **Not exposed**; client-side only |
| Enumerate all my chats (`chat-list`) | Needs **Bot capability** activated (error `232025`) |
| Resolve group chat names | Needs bot capability + `im:chat:readonly` |
| Send as bot | Needs `im:message:send_as_bot` + `im:message` on a **published** version |
| `messages-search` time format | Numeric offset, no ms (`+00:00`); `.sssZ` → `99992402` |
| Patch/edit a sent card | No message-patch method → re-render + resend |

## Out of scope (for now)

Scheduled auto-delivery (later via cron), multi-user, keyword filters
(`digest urgent`), true unread (blocked by Lark API), in-place card editing.
