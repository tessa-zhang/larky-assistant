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
- **Cap at `MAX_MESSAGES`** (default 200) per run as a rate-limit guard, and
  report how many were dropped (never truncate silently).

---

## AI classification

Each surviving message gets an `urgency`, a `category`, and a ≤15-word `summary`
focused on what the sender needs from me.

**Urgency**
- `high` — action required today: incident/outage/blocking, explicit sign-off, "urgent/ASAP/down/broken"
- `medium` — response needed but not time-critical: reviews, questions, feedback
- `low` — informational / FYI / casual chatter, no action needed

**Category** — `incident` (prod broken/degraded), `decision_needed` (my approval
or choice required), `review_request` (PRD/doc/code/design), `question` (I'm being
asked something), `fyi` (informational only).

In the **agent-driven skill** the agent classifies inline; in the **Node app** a
chunked Claude call (`claude-sonnet-4-6`, ≤40 msgs/call, run concurrently) does
it, with a `low`/`fyi` fallback so a message is never dropped on a parse error or
when no API key is set.

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
- **Commands:** in bot mode, DM the bot `digest` (case-insensitive) → it posts a
  loading ack (`⏳ Fetching your mentions…`) then the card; `done <n…>` /
  `snooze <n…>` manage items. In CLI mode: `npm run digest | done | snooze | listen`.
- **All Lark calls:** shell out to `lark-cli`; it owns token storage + refresh.
- **Send identity:** `SEND_AS=user` → digest to my **self-chat** (works today);
  `SEND_AS=bot` → bot replies in its DM (needs bot scopes + published version).
- Two delivery forms of the same logic: the **`lark-triage` skill** (agent
  classifies inline, on-demand) and the **Node app** (`npm run digest|listen`,
  unattended/scheduled).

## Configuration (env vars — see `.env.example`)

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required) | Claude classification; without it every item falls back to `low`/`fyi` |
| `SEND_AS` | `user` | `user` → deliver to my self-chat (works today); `bot` → bot DM reply (needs published bot-send scopes) |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Classification model |
| `LOOKBACK_HOURS` | `24` | Max lookback per run (the cap). `LOOKBACK_DAYS` still honored for back-compat (×24) |
| `WATERMARK_LOOKBACK_DAYS` | `14` | How far back to scan my own messages when building the reply watermark |
| `SNOOZE_HOURS` | `24` | How long `snooze` hides an item |
| `LOW_DISPLAY_LIMIT` | `10` | Max LOW/FYI items rendered on the card (rest → "+N more") |
| `MAX_MESSAGES` | `200` | Per-run fetch cap (rate-limit guard) |
| `LARK_USER_OPEN_ID` | auto | Override my open_id (else auto-detected from `auth status`) |

No Lark secrets here — `lark-cli` owns Lark auth.

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

## Non-functional requirements

- **On-demand only** — no polling; a run happens when I trigger `digest` (or `npm run digest`).
- **Idempotent** — `lastRunAt` advances each run; re-running back-to-back doesn't
  re-surface the same items.
- **Graceful empty state** — `✅ You're all caught up! …` when nothing is unread.
- **State persistence** — local JSON only, no DB (see State section).
- **Latency** — incremental runs are fast, but a first/large run is **not**
  real-time: the reply-watermark adds a `--sender` search over
  `WATERMARK_LOOKBACK_DAYS`, so a wide window can take tens of seconds (~33s for
  24h, ~80s for 7d observed). The original "<10s" target does **not** hold for
  large backlogs — acceptable for an on-demand tool, and the 24h cap keeps the
  common case small.
- **Privacy** — message text is sent to the Anthropic API for classification;
  confirm this is acceptable for internal content before wider use.
- **Auth resilience** — owned by `lark-cli`; a `needs_refresh` token is still
  usable (it refreshes on the next API call), so runs don't fail on it.

## Out of scope (for now)

Scheduled auto-delivery (later via cron), multi-user, keyword filters
(`digest urgent`), true unread (blocked by Lark API), in-place card editing.
