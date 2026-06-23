# Lark Triage Bot — Spec (v2, living)

> Supersedes the original `lark-triage-bot-spec.md`. This version reflects
> decisions made during build + the real constraints of the Lark API and the
> `lark-cli` toolchain. Where v1 and v2 disagree, **v2 wins**.

---

## Requirements & progress (start here)

Living checklist — the at-a-glance "where are we." Tick items as they ship; new
feedback lands as a **Roadmap** item (bottom), then graduates up here once built.

**✅ Shipped**
- [x] Unread @mentions (group) + DMs digest, on demand
- [x] "Unread" via reply-watermark proxy (+ `-3` thread-reply sentinel handling)
- [x] **Reactions = addressed** — drop messages I've reacted to *(2026-06-17)*
- [x] **@all detection** — tag `📣 @all` + bias low; kept, not dropped *(2026-06-17)*
- [x] AI urgency / category / ≤15-word summary classification
- [x] Interactive card: urgency-grouped, numbered, verbatim excerpt, jump link
- [x] `done` / `snooze` text commands (re-render from cached snapshot)
- [x] Fixed 3-day lookback window (re-surfaces current backlog each run)
- [x] Bot/app + noise-channel filtering; per-run cap with skip reporting
- [x] Local JSON state, no DB
- [x] **Jump-button link fix** — Lark emits a broken `/client/thread/open` applink
      for thread messages; rebuild it as a working `/client/chat/open` link *(2026-06-18)*
- [x] **Date-only lookback label** — drop the time from the "since …" subtitle (it's
      a fixed window, so the time looked static) *(2026-06-18)*
- [x] **R4 — Thread-aware unread** (bug fix): per-thread watermark so thread @s clear
      when I engage *that thread* — and don't vanish when I post elsewhere (folds Item A)
      *(2026-06-23)*

**🔜 Next** (detail in [Roadmap](#roadmap))
- [ ] **R6 — Per-chat multi-message summary**: summarise across all unread in a chat,
      not just the latest (verbatim line still shows the latest)
- [ ] **R5 — cc-mention down-ranking**: detect textual `cc @me`, tag + bias low (3rd
      lane alongside @all)
- [ ] **R3 — Concise / expandable digest** (should-have): collapse the digest so a
      14-item run stays scannable instead of a wall of text
- [ ] **R7 — Interactive per-item done/snooze**: per-row buttons; `done` drops a ✅
      reaction so it survives without a global list (needs callback spike + R2)
- [ ] **R8 — Dynamic lookback** (to design): start-of-week moving window; track every
      unaddressed @ so nothing ages out silently
- [ ] **R1 — Priority groups** (should-have, opt-in): surface/consider non-@
      messages from groups I designate as relevant
- [ ] **R2 — Hosted bot** (committed direction): frictionless, installable + runnable
      *without an IDE*, ideally entirely inside Lark

---

## Goal

On demand, surface **everything addressed to me that I haven't dealt with yet**
— my **unread @mentions** and **unread DMs** — classify them by urgency with AI,
and deliver one prioritised, interactive digest card I can act on (jump / done /
snooze). Read/handled chatter must not appear. **Reacting** to a message counts as
handling it; **@all** broadcasts are kept but flagged and down-ranked (they're not
personally directed).

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

**Thread/topic replies** come back with the sentinel `message_position = "-3"`
on the main timeline (not a real sequence number) but carry a real per-thread
`thread_message_position`. The watermark is therefore built on **two axes** (R4,
shipped 2026-06-23): `chat_id → max(message_position)` *and*
`thread_id → max(thread_message_position)`, both from my own messages. A candidate
is tested on **the axis it actually has a real position on**:

- a message with a real `thread_message_position` is scoped to its **thread**
  watermark (the chat watermark is ignored) — so my in-thread reply clears it, and
  posting elsewhere in the chat does *not*;
- everything else (non-thread, plus thread messages mirrored to main with a real
  `message_position`) uses the **chat** watermark, as before;
- a message with **no** real position on either axis (the "-3" sentinel *and* no
  thread position — rare) is *uncomparable ⇒ unread*: it surfaces once, clearable
  with `done`.

(~half of @mentions are thread replies, so this matters a lot.)

### The reaction rule (also = "addressed")

> A message I've **reacted to** (any emoji) is treated as **read/addressed** and
> dropped, exactly like one I replied to.

Same family as the watermark, but **per-message** rather than a chat watermark:
reacting to message X addresses X only — not earlier messages I didn't react to.
A 👍 / ✅ / 👀 is how people acknowledge "got it" without replying, so honouring
it removes a whole class of false positives.

Unlike read-state, reactions **are** readable: `im reactions batch_query --as user`
returns each reaction's `operator.operator_id`, so we detect *my own* reactions by
matching my `open_id`. Mechanics: batched at **20 message_ids/request** (the API
cap), run concurrently, applied to the smallest candidate set (after the local +
name filters) to minimise calls. **Fails open** — a lookup error leaves messages
shown, never hidden. *Blind spot:* `page_size_per_message` caps at 10, so a message
with >10 reactions where mine isn't in the first 10 is missed (rare; re-surfaces
once, clearable with `done`).

**Layered with the other filters**, an item is shown only if ALL hold:
1. **Unread** by the watermark rule **and not reacted to** by me (above).
2. **Not** in `doneMessageIds` and **not** currently snoozed.
3. Within the **lookback window** — a **fixed** `LOOKBACK_HOURS` (default **72h /
   3 days**): `start = now − LOOKBACK_HOURS`, **independent of when the digest last
   ran**. Running a digest doesn't read anything, so each run must re-surface the
   whole current unread backlog in the window — not just messages newer than the
   last run. Items leave the digest only by replying (watermark), reacting, `done`,
   or `snooze`.

**Known blind spot (irreducible):** a message I *read but never replied or reacted
to* (e.g. a "sureee" closer, or a group @mention I read silently) will appear once.
I clear it with `done`, or it ages out of the window. This is the unavoidable
cost of Lark having no read API. *(The thread-reply false positive/negative this
note used to flag is **fixed** as of the per-thread watermark — R4, 2026-06-23.
A narrow residual remains: a thread message with **no** real position on either
axis surfaces once, clearable with `done`.)*

---

## @mentions vs @all (broadcasts)

Lark's "@ Mentions" tab — and therefore `--is-at-me` — counts **@all** as "at me"
(it includes everyone). Measured on a real 2-week window, **~11%** of returned
"mentions" were `@all` blasts, not someone naming me. They were being classified
identically to a direct ping.

The two are **cleanly separable** by structure, not fragile text-matching:
a **direct @me** always carries my `open_id` in the message's `mentions[]` array;
an **@all** never does (it only renders `@all`/`@_all` as text). So:

> `isBroadcast = (group message) AND (my open_id ∉ mentions[])`. DMs are never
> broadcasts.

**Decision: keep, but flag + down-rank.** Broadcasts stay in the digest (some
all-hands posts matter) but are tagged **`📣 @all`** on the card and biased toward
**low/fyi** at classification — they may only reach `medium` when they demand a
concrete action from me (RSVP, form by a deadline) and `high` only for a genuine
incident. The down-rank rides the existing LOW-bucket cap, so broadcast noise
self-limits.

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
`mentions[]`, **`thread_id` + `thread_message_position`** (present on thread/topic
messages), and **`message_app_link`**. The applink is used verbatim for the Jump
button on **non-thread** messages, but for thread messages Lark emits a **malformed
`/client/thread/open`** link that won't navigate — we rebuild it as a working
`/client/chat/open?openChatId=…&position=…` link from `chat_id` + `message_position`
(see `jumpLink` and the limitations table).

### Filtering after fetch
- Apply the **watermark rule** to mentions **and** DMs.
- Drop messages I've **reacted to** (reaction rule) — `reactions batch_query`,
  matched on my `open_id`, on the post-filter candidate set.
- Mark group messages where my `open_id` ∉ `mentions[]` as **`isBroadcast`** (@all);
  keep them, but they're labelled and down-ranked downstream.
- Drop my own messages (`sender.id == SELF`).
- Drop **automated senders** — `sender_type` of `bot` *or* `app`. The
  `--exclude-sender-type bot` search flag drops only `bot`; `app` senders (release
  cards, alert apps, Slack mirrors) slip through it, so they're dropped here too.
- Drop `done`/snoozed; drop `deleted`; drop messages with **no meaningful text**
  after stripping placeholders (`[Sticker]`, `[Image: …]`, `[File: …]`, …).
- Drop known **noise channels** by name *when resolvable* (`unbookable-item-alert-*`,
  `cross-sell-null-item-alert-*`, `merchandising_oncall`, `release-and-hotfix`,
  `promo-error-report`, `*| Slack`). Name resolution needs bot capability +
  `im:chat:readonly`; until then, `--exclude-sender-type bot` + the `app` filter
  carry it.
- Dedupe by `message_id`, then **collapse to one row per chat** — the latest
  unread message, mirroring Lark's "@ Mentions" tab. The kept row carries
  `chatUnreadCount` so the card can show "+N more" for that chat.
- **Cap at `MAX_MESSAGES`** (default 200) per run (now post-dedup, so it caps
  chats) as a rate-limit guard, and report how many were dropped (never truncate
  silently).

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

**Broadcast bias** — each message carries an `is_broadcast` flag (the @all signal
above). Broadcasts are biased to `low`/`fyi`; they reach `medium` only when they
demand a concrete action from me, `high` only for a genuine incident.

A chunked Claude call (`claude-sonnet-4-6`, ≤40 msgs/call, run concurrently) does
the classification, with a `low`/`fyi` fallback so a message is never dropped on a
parse error or when no API key is set.

---

## Digest card

Lark interactive card. Grouped 🔴 HIGH / 🟡 MEDIUM / 🟢 LOW, **items numbered
1..N globally** (numbers are how `done`/`snooze` reference items). One row per
chat (latest unread). Each item:
- label `[chat name]` for groups (falls back to `[sender · group]` until bot
  capability resolves names) or `[sender · DM]` for DMs, plus category, a
  **`📣 @all`** tag when `isBroadcast`, relative time, and `· +N more` when the
  chat has further unread messages;
- the AI **summary** (what the sender needs from me);
- the **verbatim message** beneath it — `💬 <sender>: "<excerpt>"`, truncated to
  `RAW_PREVIEW_CHARS` (≈2 lines) — so I can triage without opening the chat (which
  would mark it read);
- a `↗ Jump to message` URL button.

LOW bucket capped (~10) with a "+N more" note. Empty state → `✅ You're all caught up!`.

---

## Done / Snooze (text commands)

There are **no card-button callbacks** over the lark-cli WebSocket event bus *(to be
re-verified in R7 — Lark does emit `card.action.trigger`)*, so today management is by
text reply referencing the card numbers:

- `done 2 3` → add to `doneMessageIds`; never resurface.
- `snooze 1` → hide for `SNOOZE_HOURS` (default 24h), then resurface if still unread.

lark-cli has **no message-patch** method, so the card is **re-rendered and
resent** (not edited in place); survivors are renumbered.

---

## State (`./state.json`)

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
- **One surface:** the **Node app** is the sole delivery form today (`npm run
  digest|listen`, unattended/scheduled); it gets wrapped behind the hosted bot at
  R2. *(An earlier standalone Claude skill was retired — one codebase to maintain.)*

## Configuration (env vars — see `.env.example`)

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required) | Claude classification; without it every item falls back to `low`/`fyi` |
| `SEND_AS` | `user` | `user` → deliver to my self-chat (works today); `bot` → bot DM reply (needs published bot-send scopes) |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Classification model |
| `LOOKBACK_HOURS` | `72` | Fixed lookback per run (3 days), independent of last run. `LOOKBACK_DAYS` still honored for back-compat (×24) |
| `RAW_PREVIEW_CHARS` | `160` | Chars of the verbatim message shown under each summary (≈2 lines) |
| `WATERMARK_LOOKBACK_DAYS` | `14` | How far back to scan my own messages when building the reply watermark |
| `SNOOZE_HOURS` | `24` | How long `snooze` hides an item |
| `LOW_DISPLAY_LIMIT` | `10` | Max LOW/FYI items rendered on the card (rest → "+N more") |
| `MAX_MESSAGES` | `200` | Per-run fetch cap (rate-limit guard) |
| `LARK_USER_OPEN_ID` | auto | Override my open_id (else auto-detected from `auth status`) |

No Lark secrets here — `lark-cli` owns Lark auth.

## Lark API limitations discovered (so we don't relitigate)

| Want | Reality |
|---|---|
| True unread / read state on *received* msgs | **Not exposed.** The only read API is `messages read_users` — **bot-only**, only for messages the **bot sent**, ≤7 days. No "have I read this?" exists. `chats.get` has no read cursor; `chat-list` has no unread field. |
| Unread badge / count per chat | **Not exposed**; client-side only |
| **My reactions on a message** | **Readable** ✅ — `reactions batch_query --as user` (cap 20 msgs/req, ≤10 reactions/msg); match `operator.operator_id` to my `open_id` |
| Tell @all from a direct @mention | `--is-at-me` returns both; distinguish by whether my `open_id` ∈ `mentions[]` |
| Enumerate all my chats (`chat-list`) | Needs **Bot capability** activated (error `232025`) |
| Resolve group chat names | Needs bot capability + `im:chat:readonly` |
| Send as bot | Needs `im:message:send_as_bot` + `im:message` on a **published** version |
| `messages-search` time format | Numeric offset, no ms (`+00:00`); `.sssZ` → `99992402` |
| Patch/edit a sent card | No message-patch method → re-render + resend |
| Jump to a **thread message** | `message_app_link` is a **malformed `/client/thread/open`** URL (duplicated, snake/lower-cased params: `open_chat_id`+`openchatid`+…) the client can't open → rebuild as `/client/chat/open?openChatId=…&position=…` (the working form; carries **no token**, so fully reconstructable from `chat_id`+`message_position`) |
| Unread state of a **thread reply** | `message_position` is the `-3` sentinel for pure in-thread replies, so they're watermarked on **`thread_message_position`** (a real per-thread sequence) via the per-thread watermark — **shipped, R4**. Note: a thread message has *either* a real `message_position` (mirrored to main) *or* a real `thread_message_position` (pure in-thread), not reliably both — so a message with neither still surfaces once (residual) |

## Non-functional requirements

- **On-demand only** — no polling; a run happens when I trigger `digest` (or `npm run digest`).
- **Stateless window (by design)** — re-running re-surfaces the *same* current
  unread backlog within `LOOKBACK_HOURS`; a digest run does **not** mark anything
  read. Items leave only via replying (watermark), `done`, or `snooze`. (`lastRunAt`
  is still recorded, but no longer gates the window.)
- **Graceful empty state** — `✅ You're all caught up! …` when nothing is unread.
- **State persistence** — local JSON only, no DB (see State section).
- **Latency** — incremental runs are fast, but a first/large run is **not**
  real-time: the reply-watermark adds a `--sender` search over
  `WATERMARK_LOOKBACK_DAYS`, so a wide window can take tens of seconds (~33s for
  24h, ~80s for 7d observed). The original "<10s" target does **not** hold for
  large backlogs — acceptable for an on-demand tool, and the 72h (3-day) default
  keeps the common case bounded.
- **Privacy** — message text is sent to the Anthropic API for classification;
  confirm this is acceptable for internal content before wider use.
- **Auth resilience** — owned by `lark-cli`; a `needs_refresh` token is still
  usable (it refreshes on the next API call), so runs don't fail on it.

## Roadmap

Committed directions + parked ideas, each with an ID the progress tracker refers
to. We assess before building — these capture **intent**, not final design.

### R1 — Priority groups (should-have, configurable / optional)

Today only **direct @mentions** and **DMs** surface. But as PM of Project A, every
Project A thread is at least worth *consideration* even when no one @'d me. Let the
user designate **priority groups**; messages there get evaluated too.

- **Optional & off by default** — opt in per group; never forces volume on people
  who don't want it.
- **Open questions:** how to pick groups (chat_id list vs name vs in-Lark picker);
  how hard to surface (every message? AI-filtered for "would Tessa actually care?");
  volume control (priority groups are chatty → a strong relevance filter + caps are
  essential); how it composes with the watermark/reaction rules; chat enumeration
  needs bot capability (ties to R2).

### R2 — Hosted bot: frictionless, no-IDE, inside Lark (committed 2026-06-17)

**Decision:** the delivery form is a **hosted bot**, not a per-user CLI —
"otherwise no one will be free enough to use it." A teammate must be able to
**install and run it without an IDE**, ideally entirely within Lark (DM the bot
`digest`). **Prioritise frictionless setup above everything else.**

- **Implies:** bot capability activated (✅ confirmed 2026-06-17 — `232025` is
  gone), then the app must **apply the scopes + publish a version**. Verified
  missing scopes as of 2026-06-17:
  - *Send as bot:* `im:message:send`, `im:message`, `im:message:send_as_bot`
  - *Chat names + enumeration (labels + R1):* `im:chat:readonly`, `im:chat`,
    `im:chat.group_info:readonly`, `im:chat:read`
  - *(Event consumer for in-Lark `digest`/`done` commands will also want a message
    read scope, e.g. `im:message.p2p_msg:readonly` — confirm when we wire it.)*
  Reading mentions/DMs/reactions already works on the **user** token (no change).
- **Key design problem:** per-user auth — each teammate's digest needs *their own*
  user-identity context to read *their* mentions/DMs. Onboarding that without an
  IDE/CLI is the crux. To brainstorm next.

### R3 — Concise / expandable digest (should-have, added 2026-06-18)

A busy digest is a wall of text: each row is header + AI summary + verbatim excerpt
+ a Jump button, so ~14 items overflow the card and stop being scannable. Make
detail collapse by default and expand on demand.

- **Lark card capability to explore:** the v2 card schema has a `collapsible_panel`
  component (and column sets) — the cleanest fit if supported on the delivery
  surface. Fallbacks if not: hide the verbatim excerpt behind "show more" (summary
  stays), or render dense one-line-per-chat rows.
- **Open question / tension:** density vs. the core "triage *without opening the
  chat*" goal, which depends on the verbatim excerpt being visible. Likely answer:
  keep HIGH expanded, collapse MEDIUM/LOW. Assess against real card limits before
  building.

### R4 — Thread-aware unread, both directions (bug fix) ✅ shipped 2026-06-23

**As built:** the watermark is now dual-axis (`chat_id → max(message_position)` +
`thread_id → max(thread_message_position)`, both from my own messages), and
`isUnread` tests each candidate on the axis it has a real position on — thread
position if present (scoped to that thread, chat watermark ignored), else the chat
watermark. Both misfires below are fixed; the residual is a thread message with no
real position on either axis (surfaces once, clearable with `done`). Covered by the
`isUnread … per-thread watermark (R4)` unit test.

Our watermark was per-**chat**, not per-**thread**, so thread @mentions misfired in
*both* directions:
- **False positive:** replying *in a thread* doesn't clear the mention — pure
  in-thread replies report `message_position = "-3"`, so the reply-watermark can't
  compare them, and my own in-thread reply is `-3` too, so it never raises the
  watermark. (The link fix shipped 2026-06-18 makes these at least **clickable**.)
- **False negative (Item A, 2026-06-18):** an *unanswered* thread @ can vanish
  because posting *anything* elsewhere in that chat raises the per-chat watermark
  past it — even though I never engaged *that* thread. Expected: keep it until I
  engage *that thread*.

- **Fix (both):** add a **per-thread watermark** — `thread_id → max(thread_message_position)`
  built from my own messages — alongside the chat watermark, and scope "read" to
  the thread for thread messages. A candidate is "read" if it falls under the
  watermark on the axis it actually has a real position on.
- **Verified viable:** my own thread replies carry a real `thread_message_position`
  (14/100 in a 14-day sample). Residual blind spot: messages where *both* positions
  are sentinels (rare) still surface once — clearable with `done`.

### R5 — cc-mention down-ranking (should-have, added 2026-06-18)

Beyond @all, there's a third lane: being **cc'd** — the sender types `cc @A @B @me`
to copy me for visibility, not to ask me to act. Lark exposes **no structural cc
signal** (`mentions[]` is just `id`/`key`/`name`), but the convention is textual:
a `cc` token followed by the @mentions. Detect it by a simple read of the message
text, then treat it like a broadcast — **tag (`👀 cc`) + bias `low`/`fyi`** at
classification (only reaching higher when it genuinely asks something of me).

- **Open:** detection precision (word-boundary `cc` near a mention vs. anywhere);
  whether to compute the flag heuristically (deterministic, drives the card tag) or
  let the classifier judge from text (it already sees it) — likely the heuristic
  flag for the tag + a prompt nudge, mirroring `is_broadcast`.

### R6 — Per-chat multi-message summary (should-have, added 2026-06-18)

Today we collapse a chat to its latest unread message and the AI summarises only
that one; the `+N more` count is real but the other messages' content is discarded.
Summarise across **all** unread messages in the chat instead ("3 msgs: needs
sign-off on X, plus a follow-up on Y"). **Decided:** the verbatim `💬` line keeps
showing the **latest** message; only the AI summary spans the bundle. Pairs with
R4, and softens Item A's multiple-@ collapse (earlier @ content stops being
invisible). Cost: a bit more classification payload per chat — fine.

### R7 — Interactive per-item done/snooze (should-have, added 2026-06-18)

Replace the text-command `done 2 3` flow with **per-row buttons** on the card.
- **Feasibility spike first:** SPEC currently records "no card-button callbacks over
  the lark-cli WS bus" — re-verify, since Lark cards emit `card.action.trigger`
  events; confirm whether we can receive them (user vs bot identity). Likely couples
  to R2 (publish + scopes).
- **State model (decided — option b):** a `done` click drops a ✅ **reaction** on the
  message (bot, on my behalf), so the existing reaction-rule treats it as addressed
  on the next run — per-item buttons **without** a growing `doneMessageIds` list and
  **without** losing the "never resurfaces" guarantee. Needs a reaction-write scope.

### R8 — Dynamic lookback window (to design, added 2026-06-18)

The fixed 72h lookback should be a **fallback**, not the curator. Direction Tessa
wants: a **moving window anchored to the start of the week**, so a week's @s/tasks
stay visible until cleared — and ideally **persistently track every unaddressed @**
so nothing is silently dropped when it ages out, with the lookback only bounding how
far back a *cold* scan reaches. **To discuss before building** — interacts with the
stateless-window design (today a run reads nothing and re-derives the backlog) and
with how items leave (reply/react/done). Quick phrasing fix shipped first
(2026-06-18): the lookback label is now date-only.

---

## Out of scope (for now)

True unread (blocked by Lark API — see the limitations table), in-place card
editing, keyword filters (`digest urgent`), scheduled cron auto-delivery.
*(Multi-user and "run without an IDE" are no longer out of scope — they're **R2**.)*
