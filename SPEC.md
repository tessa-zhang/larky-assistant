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
- [x] Fixed **7-day** rolling lookback window (re-surfaces current backlog each run; default
      bumped 72h→168h on 2026-07-02 — see **R8** for the parked stable-anchor follow-up)
- [x] Bot/app + noise-channel filtering; per-run cap with skip reporting
- [x] Local JSON state, no DB
- [x] **Jump-button link fix** — Lark emits a broken `/client/thread/open` applink
      for thread messages; rebuild it as a working `/client/chat/open` link *(2026-06-18)*
- [x] **Date-only lookback label** — drop the time from the "since …" subtitle (it's
      a fixed window, so the time looked static) *(2026-06-18)*
- [x] **R4 — Thread-aware unread** (bug fix): per-thread watermark so thread @s clear
      when I engage *that thread* — and don't vanish when I post elsewhere (folds Item A)
      *(2026-06-23)*
- [x] **Position-0 unread fix** (bug): Lark `message_position` is **0-indexed**, so a
      chat's first message is `"0"` — it was conflated with "missing" and treated as
      permanently unread (a replied-to first DM kept resurfacing). A real `0` now
      compares against the watermark like any position; only the `-3` sentinel and a
      truly absent value are uncomparable. *(2026-06-23)*
- [x] **Case-B thread-root unread fix** (bug): an @mention that *starts* a thread arrives
      with a real main `message_position` but **no** `thread_message_position` (a "mirrored
      to main" root — confirmed live). `isUnread` routed it to the **chat** axis, but the
      natural reply — *inside the thread* — is a `-3` that only raises the **thread**
      watermark, so the mention resurfaced forever despite the reply (the "I reply in-thread
      and it never clears" report). Fix: a thread message with **no** thread position but a
      **real main position** is read once I've engaged its thread (a thread watermark
      exists); if I haven't, it keeps the chat axis so a main-timeline reply still clears it.
      Guarded to `position != null`, so the positionless "surfaces once" residual is
      unchanged. Verified live (the stuck `om_…01e40b`, replied in-thread at thread-pos 4,
      now clears) + unit-tested. **Bug lived in shared watermark logic — not the multi-user
      work** (that branch's `--profile` threading is clean). *(2026-07-01)*
- [x] **R6 — Multi-message / thread summary** *(2026-06-24)*: a digest row now summarises
      the whole **unread bundle**, not just the latest message — **per thread** for group
      @s (thread fetched via `threads-messages-list`), **per DM** for DMs. The grouping
      unit shifts chat→thread for threaded @s (`groupRows` + `bundleKey`). Token cost is
      kept ~flat per thread (it'd balloon at team scale) via a **salient slice** — thread
      head + @mention neighbourhood + unread tail, capped to `THREAD_BUNDLE_MAX_MSGS` with
      gaps elided and each line clipped to `BUNDLE_MSG_CHARS` — plus a fetch-on-demand gate
      (a lone, long @-line skips the fetch). ≤15-word bundle summary that leads with the
      ask; verbatim still shows the latest. @all stays single + downranked. Thread rows
      carry a `🧵 <topic>` label so several threads in one chat are distinguishable.
- [x] **R3 — Concise / expandable digest** *(2026-06-24)*: the digest card migrated to the
      **v2 schema** (`schema: "2.0"`, top-level `elements` → `body.elements`, text as `markdown`
      elements, jump buttons carry their URL via `behaviors[open_url]`), and the **LOW / FYI**
      bucket now renders inside a **collapsed `collapsible_panel`** — HIGH + MEDIUM stay
      expanded. The panel header keeps the count (`🟢 LOW / FYI (N)`) so you see how many low
      items exist without expanding; the per-bucket cap + "+N more" line live inside it.
      Verified end-to-end on self-chat (card accepted + delivered). Discovered + worked around:
      **schema 2.0 drops the `note` element** — footer + overflow line moved to `markdown`.
- [x] **R2 pre-launch token guard — per-thread summary cache** *(2026-06-24)*: a thread row's
      classification (urgency / category / ≤15-word summary) is cached in `state.json`, keyed by
      `thread_id` + newest `thread_message_position` + my per-thread watermark (`threadCacheKey`).
      On a later run an **unchanged** thread (no new message, I haven't replied) reuses the stored
      answer with **zero Anthropic tokens** — only the token-free Lark thread fetch (which is how
      we detect "unchanged") still runs. Orphaned keys (a thread advanced ⇒ its old key never
      matches) age out via a TTL (`THREAD_CACHE_TTL_HOURS`, default 14d; `0` = kill switch).
      Per-user by construction (cache lives in that user's state; the key encodes my watermark).
      **Closes the R2 pre-launch gate.** Unit-tested; **live two-run verification done 2026-06-26**
      — a bot-mode rerun on the same backlog reused a thread summary at **0 Anthropic tokens**.
- [x] **LOW-only digest expands** (R3 refinement) *(2026-07-02)*: when **LOW/FYI is the only
      bucket** (no HIGH/MEDIUM), it now renders **expanded/flat** instead of inside the collapsed
      panel — a lone collapsed bucket reads like the empty state and hides the only content behind
      a tap. Collapse still kicks in whenever HIGH/MEDIUM are present (that's what it protects).
      *(Superseded 2026-07-20: the `LOW_DISPLAY_LIMIT` cap + "+N more" line were **retired** — LOW
      now lists every item; see the "no-cap + `done all`" entry below.)* Unit-tested + visually
      verified on both paths.
- [x] **Noise filter no longer hides direct @s** (bug) *(2026-07-02)*: a live trace found a real
      direct @me in `ta-engineer-coordination | Slack` being dropped (its resolved name carries a
      hidden `| Slack` suffix). Two fixes: (1) the **`… | Slack` pattern is removed** — those are
      real human coordination channels, not noise (their @all blasts now surface in the downranked
      LOW bucket; tighten later only with cause); (2) the remaining noise-name patterns now suppress
      **broadcasts only** — a **direct @me surfaces even in a noise channel**
      (`isExcludedChatName && isBroadcast`), since the filter is for @all/automation spam, not
      people naming me. Bot/app senders are still dropped upstream, so only a real person's ping
      survives. Unit-tested + verified against the live trace set. *(Same trace confirmed the
      Case-B/`isUnread` logic is **correct** — a mirrored @ dropped there was genuinely replied to
      in-thread; not a bug.)*
- [x] **Digest in-flight guard** (bot-listener hardening) *(2026-07-02)*: a second `digest` sent
      before the first returns no longer fires a second concurrent pipeline. Each digest is a burst
      of Lark calls; overlapping runs doubled it and tripped Lark's **`99991400` request-frequency
      limit** (hit live). A per-listener in-flight flag now ignores duplicate triggers while a run
      is active — the first run's "⏳ Fetching…" ack already signals it's working. Single-user
      today; R2 multi-user keys it per user. See the limitations table.
- [x] **Direct-@me from bots/apps rescued** (@-filter fix) *(2026-07-14)*: sender filtering moved
      fully in-code (`passesSenderFilter`); a **bot/app that @mentions me directly in a group is
      kept** (`!isDM && !isBroadcast`), while bot/app **broadcasts + automated DMs still drop**. Root
      cause: the `--exclude-sender-type` API flag is too blunt — verified it drops `app` as well as
      `bot` and can't see `mentions[]`, so it was silently eating ~25% of real @mentions (a workflow
      "booster" app pinging me by name with refund/issuance/escalation asks). Dropped the flag on the
      mention search (kept on p2p as a free pre-filter). Live-verified: 12 direct-@me app pings
      resurfaced, 3 bot broadcasts still dropped. Unit-tested. Partly closes **R11**.
- [x] **Per-@ count badge + expander** (R6 follow-up) *(2026-07-16)*: a bundled row (thread/chat) now
      shows a **`N @you` badge** when it holds >1 unreplied direct @me, and — at top level — a
      collapsible **per-@ expander** listing each ask (sender + excerpt + its own jump), so a multi-ask
      thread no longer hides earlier @s behind the single bundle summary. Thread stays the row unit (R6
      intact); the expander is **not** nested inside the LOW/FYI panel (Lark 2.0 nested-collapsible
      unverified). `groupRows` carries `mentions`/`mentionCount`, persisted through the snapshot for
      done/snooze re-renders. Card accepted live (31-item send); unit-tested.
- [x] **Actor-relative urgency — "Named ≠ asked"** (@-classification fix) *(2026-07-16)*: urgency is now
      judged by **what *I* must personally do**, not the topic's severity — routing/FYI notes that name
      me so *others* act are `low` even on an urgent topic. Fixes booster "escalation-contact" pings
      riding a live-incident topic into HIGH. The classifier is told my name (to tell "to me" from
      "about me"); the summary cache is versioned so it re-classifies rather than serving stale verdicts.
      Live: booster routing-notes all demoted to LOW with self-explaining summaries (0 high / 2 med / 25
      low). Subsumes the @all broadcast bias + much of **R5**. **Calibration confirmed (Tessa,
      2026-07-16):** mediums were genuinely her action items; the per-LOW `FYI:` summaries land as
      assurance nothing's missed. Unit-tested + live-verified.
- [x] **LOW/FYI lists all + `done all`** (digest UX) *(2026-07-20)*: retired the `LOW_DISPLAY_LIMIT`
      display cap — LOW still collapses behind the panel (R3), but expanding now lists **every** low
      item (each with its `FYI:` summary) instead of "~10 + N more" with an unreachable, unactionable
      tail. Added **`done all`** to clear the whole delivered digest in one command — safe by
      construction (no cap ⇒ the snapshot equals what was shown, so nothing unseen is cleared). LOW
      volume stays bounded by `MAX_MESSAGES`. Config knob + `.env`/table refs removed; unit-tested.
- [x] **Per-user state keying** (R2 multi-user) *(2026-07-20)*: state moved from a single shared
      `state.json` to **`state/<open_id>.json`** — done/snooze/digest-snapshot/summary-cache are now
      isolated per user, so one user's `done`/`done all` can never act on another's digest (the old
      shared `lastDigest` slot was the break). The acting user's `open_id` is threaded through
      `runDigest`/`runDone`/`runSnooze` (DM sender in bot mode, `self` in CLI); `STATE_DIR` overrides
      the location; the legacy single file migrates once into the first user's file. `state/`
      gitignored (holds confidential booking data). Closes R2 remaining-item (2); the multi-tenant
      listener + per-user `--profile` reads (item 3) is the next piece. Unit-tested (per-user
      isolation) + path-traversal-safe.

**🔜 Next** (detail in [Roadmap](#roadmap)) — near-term sequence: **R2 launch**. (R8's interim
7d bump shipped 2026-07-02; its fuller stable-anchor design is parked, not blocking.)
- [ ] **R2 — Hosted bot** (committed; the launch step after R3): frictionless, installable +
      runnable *without an IDE*, ideally entirely inside Lark. **Pre-launch token-guard gate:
      ✅ shipped + live-verified 2026-06-26** (per-thread summary cache, above). **Decisions
      (2026-06-24):** real **bot** delivery surface (not self-chat) + **curated** beta auth —
      named beta users authorize their own user token once via a link; self-serve in-Lark OAuth
      is the fast-follow. **Auth mechanism settled (2026-06-26): device flow via lark-cli
      profiles** — lark-cli is multi-user via `profile` (+ per-command `--profile`), so each user
      gets a profile and lark-cli owns token storage/refresh; no custom OAuth server/token store
      needed for the beta. (Code flow = the one-tap self-serve upgrade later; needs a public
      redirect endpoint + our own token store + moving reads off lark-cli.)
      **✅ Bot UNBLOCKED + single-user loop proven (2026-06-26):** admin published/provisioned the
      bot on a **new app** `cli_aaaba7cf9a211ed1`; `bot_identity: pass`. User identity
      re-established on the new app via **device-flow login** (`auth login --no-wait` → approve QR
      → `--device-code`; granted `im`+`contact`+`search:message`+`offline_access`; new per-app
      open_id `ou_1e1aec…`). `npm run digest` verified end-to-end in **both** user-mode (self-chat,
      15 items) and **bot-mode** (the R2 surface — v2 card delivered, cache reused 1 summary at 0
      tokens). **Remaining for R2:** the multi-user build — (1) bot-driven onboarding
      (`p2p_chat_create` → Authorize card → per-user device-flow into a fresh profile),
      (2) ✅ **per-user state (done/snooze/cache keyed by user) — shipped 2026-07-20**
      (`state/<open_id>.json`; see State section + tracker), (3) multi-tenant listener that routes
      each user's `digest`/`done`/`snooze` to a run under their `--profile`, (4) an always-on host
      for the event listener.
      **✅ RELAUNCHED on the least-privilege app (2026-08-04):** migrated off `cli_aaaba7cf9a211ed1` to a
      **from-scratch least-privilege app `cli_aacf7cc512b8ded2`** (new open_id `ou_566409…`). Locked
      **11-scope** user-consent set + the bot chat-interface (event `im.message.receive_v1` +
      `im:message.p2p_msg:readonly`, persistent connection). Verified end-to-end: `SEND_AS=bot` digest
      delivered a live card (49 items; watermark skipped 361 read + 10 reacted), and inbound DM `hello`
      received over the bot. `SEND_AS` default flipped `user`→`bot`. Cost 4 approval rounds + a
      `base`-vs-`basic_profile` naming trap (see Least-privilege section). **Still remaining for R2:**
      (1) bot-driven onboarding, (3) multi-tenant profile-routing listener, (4) always-on host — the cohort build.
- [ ] **R12 — Beta scheduling & host** (self-beta, added 2026-07-02; near-term, precedes R2's
      always-on host): run the digest on a fixed interval (default hourly, new user env knob) and
      keep the command listener up **unattended while my laptop is awake** — the pragmatic stopgap
      before R2 item (4). Laptop-only/awake-only by decision (a closed lid sleeps); `launchd`-supervised;
      delivery via self-chat, no bot provisioning needed. Not building yet — captured on Tessa's call.
- [ ] **R8 — Dynamic lookback** (to design; **interim shipped 2026-07-02**): the fixed window's
      default was bumped **72h→168h (7d)** as the pragmatic ~80%-of-the-value step — a week matches
      most people's clear-out rhythm, and it stays a **user-varyable knob** (the ideal range is
      role-dependent). **Still open (the real R8):** the window is still *rolling*, so items slide
      off the far edge; a **stable weekly anchor** would stop that slide. A full anchor design
      (Friday-before-Monday, resets Monday) + persistent tracking were worked through 2026-07-02 and
      **deferred** — the anchor bakes in a "weekly clearing" assumption that may not fit every role,
      and persistent tracking would dump a huge backlog on a new user's first digest. See Roadmap R8.
- [ ] **R5 — cc-mention down-ranking** (largely covered 2026-07-16 by actor-relative classification —
      a cc now reads as "named, not asked" → `low`; what's left is the explicit **`👀 cc` tag** +
      deterministic detection so the card shows *why* it's downranked): detect textual `cc @me`, tag +
      bias low (3rd lane alongside @all)
- [ ] **R14 — End-of-day "Catch Me Up" brief** (good-to-have, added 2026-07-20): a once-a-day,
      glanceable **synthesis** of the LOW/FYI bucket — the *"what happened around me"* mirror of the
      digest's *"what must I do."* cc's / @all's / routing notes distilled into a few themed lines
      (not re-listed) so awareness info doesn't get scrolled past. Pragmatic first cut = an on-demand
      `catchup` command (no host dep); scheduled EOD delivery rides **R12**. See Roadmap R14.
- [ ] **R7 — Interactive per-item done/snooze**: per-row buttons; `done` drops a ✅
      reaction so it survives without a global list (needs callback spike + R2)
- [ ] **R13 — In-Lark interactive triggers** (added 2026-07-09; shares R7's card-callback spike):
      a **`↻ Refresh` button on the digest card** to re-run without typing `digest`, and — optionally —
      a **persistent bot menu** as an always-available trigger. **Gated on the same unverified
      capability as R7**: callback events over the lark-cli WS bus (we consume only
      `im.message.receive_v1` today; `done`/`snooze` are text for exactly this reason). Build the
      button *with* R7's spike — one plumbing change unlocks both. Not building yet.
- [ ] **R1 — Priority groups** (should-have, opt-in): surface/consider non-@
      messages from groups I designate as relevant
- [ ] **R9 — Org-signal triage** (low-priority / good-to-have): weight urgency by the
      sender's org relationship to me — reporting-manager chain + department proximity —
      so a ping from my manager or my own team ranks above a distant cross-org one
- [ ] **R10 — Mute-aware triage** (low-priority / good-to-have): honour chat mute/DND as an
      explicit "I don't care here" signal — drop or hard-downrank @s from muted chats. Gated
      on a feasibility spike: is per-user mute status even queryable? (unread-badge precedent
      suggests maybe not)
- [ ] **R11 — Alert-channel urgency pass** (low-priority / good-to-have, explore-first; **direct-@me
      part shipped 2026-07-14**): the direct-@me-from-a-bot/app carve-out now rescues pings where a bot
      names me. **Residual:** a bot that *broadcasts* an incident to an alert channel with no direct
      @me still drops — that firehose case still needs a relevance filter + cap.

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
3. Within the **lookback window** — a **fixed, rolling** `LOOKBACK_HOURS` (default
   **168h / 7 days**, bumped from 72h on 2026-07-02): `start = now − LOOKBACK_HOURS`,
   **independent of when the digest last ran**. Running a digest doesn't read
   anything, so each run must re-surface the whole current unread backlog in the
   window — not just messages newer than the last run. Items leave the digest only
   by replying (watermark), reacting, `done`, or `snooze`. Because it rolls with
   `now`, an item still slides off the far edge after a week — a *stable weekly
   anchor* that stops the slide is the parked follow-up (**R8**).

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
#    NB: NO --exclude-sender-type here — that flag also drops `app` senders and can't
#    see mentions[], so it was silently killing real direct @me pings from workflow
#    apps. Sender filtering is done in-code (passesSenderFilter), where a bot/app that
#    names me directly is kept. (2026-07-14)
lark-cli im +messages-search --as user --is-at-me --chat-type group \
  --start <LOOKBACK> --page-all --json

# 2. DMs (p2p) — note: NOT --is-at-me; returns my own messages too (needed for watermark).
#    Keeps --exclude-sender-type: an automated DM is dropped in-code anyway, so
#    pre-filtering it at the API is free (no behavioural change), just less to fetch.
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
- Filter **automated senders** in-code (`passesSenderFilter`) — `sender_type` of `bot`
  *or* `app` (release cards, alert apps, Slack mirrors, workflow/booster apps). Dropped
  by default, **except a bot/app that @mentions me directly in a group** (`!isDM &&
  !isBroadcast`): a workflow/booster app naming me by open_id is a real, actionable ask,
  not broadcast noise, so it's kept (mirrors the noise-channel direct-@me carve-out).
  This is done **in-code, not via `--exclude-sender-type`**: that API flag is too blunt —
  verified live it drops `app` as well as `bot`, and it can't inspect `mentions[]`, so it
  was silently killing ~25% of real @mentions (2026-07-14). An automated **DM** has no
  `mentions[]` axis ⇒ still dropped.
- Drop `done`/snoozed; drop `deleted`; drop messages with **no meaningful text**
  after stripping placeholders (`[Sticker]`, `[Image: …]`, `[File: …]`, …).
- Drop known **noise channels** by name *when resolvable* — but **only broadcasts** in
  them; a **direct @me is kept** (`isExcludedChatName && isBroadcast`), since the filter
  targets @all/automation spam, not people naming me (2026-07-02). Patterns:
  `unbookable-item-alert-*`, `cross-sell-null-item-alert-*`, `merchandising_oncall`,
  `release-and-hotfix`, `promo-error-report`. The **`*| Slack` pattern was removed
  (2026-07-02)** — those are real human coordination channels, not noise; their @all blasts
  now land in the downranked LOW bucket. Name resolution needs bot capability +
  `im:chat:readonly`; until then, `--exclude-sender-type bot` + the `app` filter carry it.
- Dedupe by `message_id`, then **collapse to one row per chat** — the latest
  unread message, mirroring Lark's "@ Mentions" tab. The kept row carries
  `chatUnreadCount` so the card can show "+N more" for that chat.
- **Cap at `MAX_MESSAGES`** (default 200) per run (now post-dedup, so it caps
  chats) as a rate-limit guard, and report how many were dropped (never truncate
  silently).

---

## AI classification

Each surviving message gets an `urgency`, a `category`, and a ≤15-word `summary`.
Urgency is judged **relative to what *I* must personally do** — not the topic's
intrinsic severity. The classifier is told **who it triages for** (my display name is
woven into the prompt via `classify(items, { userName })` → `systemPrompt`) so it can
tell a message addressed *to* me from one that merely *names* me.

**Urgency (actor-relative — the crux)** — a message can describe a serious incident
yet require nothing from me, in which case it's `low` *for me*:
- `high` — **I personally** must act today: I'm the one asked to decide, approve, sign
  off, unblock, or answer something time-critical; or an incident I own.
- `medium` — my input/response is wanted but not time-critical: reviews, questions
  directed at me, feedback I owe.
- `low` — no action needed from me: informational/FYI, or I'm only named for awareness,
  context, or routing.

**Named ≠ asked** — being @mentioned doesn't mean I must act. Routing/hand-off notes
that name me so *others* act ("please mention Tessa for warehouse issues", "loop in",
"X handles Y"), cc/FYI, and passing mentions are `low`/`fyi` **regardless of topic
severity**. The gate: *does the sender need **me** to do something?* (Added 2026-07-16,
after the bot-sender rescue surfaced booster "escalation-contact" routing notes as
false HIGH — the topic was a live incident, but the ask was on the reader, not me.)
This **subsumes the old broadcast bias** (an @all is just the strongest "named, not
asked" case — `is_broadcast` is still passed as a signal) and covers much of **R5** (a
cc = named, not asked).

**Category** — `incident` (prod broken/degraded), `decision_needed` (my approval or
choice required), `review_request` (PRD/doc/code/design), `question` (I'm being asked
something), `fyi` (informational only, or I'm only looped in).

A chunked Claude call (`claude-sonnet-4-6`, ≤40 msgs/call, run concurrently) does the
classification, with a `low`/`fyi` fallback so a message is never dropped on a parse
error or when no API key is set. The per-thread **summary cache** is versioned
(`SUMMARY_CACHE_VERSION`, [fetchMentions.js](src/fetchMentions.js)) so a classifier
prompt change re-classifies rather than serving stale verdicts.

**Calibration — confirmed (Tessa, 2026-07-16)** — the reframe is aggressive by design,
so the risk was over-demoting a politely-phrased real ask. Validated on the live card:
the `medium` items were **genuinely her action items**, the booster routing-notes all
sat in `low`, and — a deliberate UX win — the per-LOW **`FYI: <why it's low>`** summary
reads as *assurance nothing's being missed* rather than a silent drop. Split is
LOW-heavy but correct for her inbox. Residual safety net regardless: a mis-ranked item
still appears (collapsed LOW) with verbatim + jump, so nothing is ever *hidden*. Lever
if it ever over-fires later: soften the "Named ≠ asked" wording.

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

LOW/FYI **collapses** behind a `collapsible_panel` when HIGH/MEDIUM are present (R3) —
but lists **every** low item inside (no display cap): each carries an assuring `FYI:`
summary, so expanding shows the whole tail instead of "~10 + N more" with no way to act
on the rest (2026-07-20). A sole LOW bucket renders flat. **`done all`** clears the
whole digest at once (safe — with no cap the snapshot is exactly what's shown). Empty
state → `✅ You're all caught up!`.

---

## Done / Snooze (text commands)

There are **no card-button callbacks** over the lark-cli WebSocket event bus *(to be
re-verified in R7 — Lark does emit `card.action.trigger`)*, so today management is by
text reply referencing the card numbers:

- `done 2 3` → add to `doneMessageIds`; never resurface.
- `done all` → clear the **whole delivered digest** at once. Safe by construction: the
  card lists every item (no display cap; LOW is only collapsed, its full contents
  reachable by expanding), so the snapshot *is* exactly what was shown — nothing unseen
  is cleared. (2026-07-20)
- `snooze 1` → hide for `SNOOZE_HOURS` (default 24h), then resurface if still unread.

lark-cli has **no message-patch** method, so the card is **re-rendered and
resent** (not edited in place); survivors are renumbered.

---

## State (`state/<open_id>.json`, per user)

State is **keyed per user** — `state/<open_id>.json`, one file each — so multiple users
on one instance never clobber each other's `done`/`snooze`/digest-snapshot/cache (R2
multi-user; **shipped 2026-07-20**). A single shared file previously let one user's
`done`/`done all` act on whoever ran `digest` last. `load(openId)`/`save(openId, state)`
own the path; the acting user's `open_id` is threaded through `runDigest`/`runDone`/
`runSnooze` (the DM sender in bot mode, `self` in CLI). `STATE_DIR` overrides the
directory (tests, hosted data volume). The pre-multi-user single `state.json` is
**migrated once** into the first user's per-user file on load (default dir only). Each
file holds:

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
| `LOOKBACK_HOURS` | `168` | Fixed **rolling** lookback per run (7 days; bumped from 72h 2026-07-02), independent of last run. User-tunable per taste/role. `LOOKBACK_DAYS` still honored for back-compat (×24) |
| `RAW_PREVIEW_CHARS` | `160` | Chars of the verbatim message shown under each summary (≈2 lines) |
| `WATERMARK_LOOKBACK_DAYS` | `14` | How far back to scan my own messages when building the reply watermark |
| `SNOOZE_HOURS` | `24` | How long `snooze` hides an item |
| `MAX_MESSAGES` | `200` | Per-run fetch cap (rate-limit guard; also bounds LOW volume) |
| `LARK_USER_OPEN_ID` | auto | Override my open_id (else auto-detected from `auth status`) |

No Lark secrets here — `lark-cli` owns Lark auth.

## Lark API limitations discovered (so we don't relitigate)

| Want | Reality |
|---|---|
| True unread / read state on *received* msgs | **Not exposed.** The only read API is `messages read_users` — **bot-only**, only for messages the **bot sent**, ≤7 days. No "have I read this?" exists. `chats.get` has no read cursor; `chat-list` has no unread field. |
| Unread badge / count per chat | **Not exposed**; client-side only |
| **My reactions on a message** | **Readable** ✅ — `reactions batch_query --as user` (cap 20 msgs/req, ≤10 reactions/msg); match `operator.operator_id` to my `open_id` |
| Tell @all from a direct @mention | `--is-at-me` returns both; distinguish by whether my `open_id` ∈ `mentions[]` |
| `--exclude-sender-type bot` scope | **Drops `app` too, not just `bot`** (verified 2026-07-14: the same 7d `--is-at-me` window returned 64 msgs without the flag vs 48 with — it removed exactly the 16 `app` msgs). It also can't inspect `mentions[]`, so it drops a bot/app **even when it @mentions me directly**. ⇒ don't use it on the mention search; filter senders in-code (`passesSenderFilter`) so a direct-@me workflow app survives |
| Enumerate all my chats (`chat-list`) | Needs **Bot capability** activated (error `232025`) |
| Resolve group chat names | Needs bot capability + `im:chat:readonly` |
| Send as bot | Needs `im:message:send_as_bot` + `im:message` on a **published** version |
| `messages-search` time format | Numeric offset, no ms (`+00:00`); `.sssZ` → `99992402` |
| `message_position` indexing | **0-indexed** — a chat's first message is `"0"`, a real comparable value. Uncomparable values are the **negative sentinels** (`-3` for a pure in-thread reply; `-1` also seen in the wild on `thread_message_position`, 2026-07-01) and a missing/garbage value — `parsePosition` maps **any negative → `null`**, so the exact sentinel value doesn't matter. Don't conflate a real `0` with "absent" (use `parsePosition` → integer-or-`null`, not `parseInt() \|\| 0`), or a replied-to first message sticks forever |
| Patch/edit a sent card | No message-patch method → re-render + resend |
| Card **schema 2.0** element support | `collapsible_panel` needs schema 2.0, but 2.0 **drops `note`** — a 2.0 card with a `note` is rejected (`200861 … unsupported tag note`). Use `markdown` for small/footer text; `hr`/`markdown`/`button` survive. Text is a standalone `markdown` element; buttons carry their URL via `behaviors:[{type:"open_url",default_url}]`, not a top-level `url`. (2026-06-24) |
| Fetch a **full thread's** messages | `im +threads-messages-list --thread <omt_/om_> --sort asc\|desc` returns the same enriched shape as search (decoded `content`, real `thread_message_position`); `+chat-messages-list` does the same for a p2p/chat. **Gotcha:** `--help` advertises `page_size` 1–500, but the API really caps it at **50** — request more and it **silently returns 0 messages** (no error), so a naive whole-thread fetch fails open to nothing. Clamp to 50. (2026-06-24) |
| Jump to a **thread message** | `message_app_link` is a **malformed `/client/thread/open`** URL (duplicated, snake/lower-cased params: `open_chat_id`+`openchatid`+…) the client can't open → rebuild as `/client/chat/open?openChatId=…&position=…` (the working form; carries **no token**, so fully reconstructable from `chat_id`+`message_position`) |
| Unread state of a **thread reply** | `message_position` is the `-3` sentinel for pure in-thread replies, so they're watermarked on **`thread_message_position`** (a real per-thread sequence) via the per-thread watermark — **shipped, R4**. Note: a thread message has *either* a real `message_position` (mirrored to main) *or* a real `thread_message_position` (pure in-thread), not reliably both — so a message with neither still surfaces once (residual). **Case B (fixed 2026-07-01):** a thread *root* / @mention that starts a thread comes back with a real `message_position` but **no** thread position; it was tested on the chat axis, so an in-thread reply (which only raises the thread watermark) never cleared it. Now: `threadId` + no thread position + real main position ⇒ read once a thread watermark exists for it. **Residual:** if lark-cli's `--sender` search doesn't return one of my in-thread replies, that thread's watermark is absent and its root still surfaces (clearable with `done`/reaction) — to watch |
| Send **as bot** (`SEND_AS=bot`, the R2 surface) | Can fail `[11205] app do not have bot` **even when the dev console shows Bot enabled + all approved and local creds are valid** (`lark-cli doctor` → `app_resolved` pass, `bot_identity` warn). `auth status` showing bot "ready" is **misleading** — it means the token is *valid*, not that a bot is *provisioned*. Root cause by elimination (2026-06-24): **tenant provisioning** — the app/bot must be *installed / made available in the workspace* (a Lark-admin step), separate from dev-console enable+approve. Not fixable client-side; not a scope, secret, publish, CLI-version, or token-cache issue (all ruled out). Verify with `lark-cli doctor` (`bot_identity: pass`), not `auth status`. **Resolved 2026-06-26** — admin published/provisioned the bot on a **new app** (`cli_aaaba7cf9a211ed1`), so `bot_identity` flipped to `pass`; the user identity was then re-established on the new app via **device-flow login** (`auth login --no-wait` → approve QR → `--device-code`). NB: a new app ⇒ a **new per-app open_id** (auto-detected; don't pin `LARK_USER_OPEN_ID` to the old one) |
| **Shrink an over-scoped user token via re-auth** | **Can't.** Lark *accumulates* prior consent — re-running `auth login --scope <subset>` while the app still *offers* the broad set returns the **full union**, not the subset (verified 2026-07-02: fresh `grantedAt`, byte-identical `scope` string, `Newly granted: (none)`). To narrow a token you must **remove the scopes at the app/console level** (the app-offered set is the ceiling; a fresh re-auth then mints a narrow token), or revoke the app in Lark's *user* security settings. `lark-cli auth logout` clears only the **local** token; re-login re-accumulates. ⇒ enforce least-privilege at the **app** layer, and verify **after** trimming. |
| Fire digests back-to-back | Trips `99991400 request trigger frequency limit`. A single digest is a **burst** — `messages-search` ×3 + `chats.get` ×N + `reactions batch_query` — so two overlapping runs (a 2nd `digest` before the 1st returns) double it and hit the cap. Mitigated by the listener **in-flight guard** (2026-07-02); also avoid rapid `npm run listen` restarts (long-connection re-establishment counts toward frequency too). **Transient** — clears after a short cooldown; not a scope/auth issue. |

## Least-privilege scopes (R2 beta) — LOCKED & VERIFIED 2026-08-04

R2 launched on a **new app `cli_aacf7cc512b8ded2`**, built least-privilege *from scratch* (not a
trim of the old broad MCP-endpoint app) — so the app-offered ceiling *is* the least-privilege set,
sidestepping the "can't pre-narrow via re-auth" trap. inlark reads as the **user**, delivers +
receives as the **bot**. Verified end-to-end 2026-08-04 (`SEND_AS=bot` digest delivered a live card;
`hello` received over the bot). **User-identity consent set = 11 scopes** — the re-auth-sensitive set,
locked before cohort onboarding:

| Function | `lark-cli` call | Scope |
|---|---|---|
| Scan @mentions + DMs | `im +messages-search` | `search:message` (+ `im:message.{group,p2p}_msg:get_as_user`) |
| Resolve **sender names** on the card | `im +messages-search` enrichment | **`contact:user.basic_profile:readonly`** — open_id→display name; the enrichment **hard-requires** it (no skip flag; caught 2026-08-03 when the digest threw `Fatal: missing contact:user.basic_profile:readonly`). ⚠️ **NOT** `contact:user.base:readonly` ("user's basic info") — a *different, insufficient* scope (base was present when the API still threw). Add by exact **code**, not the console label. |
| Thread context (R6) | `im +threads-messages-list` | `im:message:readonly` |
| Read own reactions | `im reactions batch_query` | `im:message.reactions:read` |
| Resolve group names **+ R10 mute** | `im chats get` / `im +chat-list --exclude-muted` | `im:chat:readonly` — covers name-resolution *and* per-user mute-listing (R10 proven queryable 2026-07-20 via `--exclude-muted`; no extra scope) |
| Identity (open_id / name) | `auth status` | `contact:user.base:readonly`, `auth:user.id:read` |
| **Org-signal triage** (R9 — a key prioritisation signal; no code yet) | `contact +get-user` (not `+user-get`) — sender's `department_ids` + `leader_user_id` (reporting manager) | **`contact:user.department:readonly`** — one granular scope unlocks **both** fields (Lark doc: *获取用户组织架构信息 / retrieve user org structure*; verified 2026-07-02 that `user.base`+`basic_profile` return **neither** — `department_ids: null`, no `leader_user_id`). Add `contact:department.base:readonly` **only** if R9 resolves dept IDs→names/hierarchy. **Design fork:** read org data **as the bot** (org-stable tenant data) ⇒ user consent stays at the base 9; read **as the user** ⇒ this scope joins the per-user consent set. Same scope covers self + colleagues (subject to tenant contact-visibility — verify live once enabled). |
| Long-lived token (auto-refresh) | — | `offline_access` (**critical** — no refresh_token; ~7-day refresh window ⇒ a user idle >7d must re-login, hit live 2026-07-29) |

**Bot/tenant scopes** (publish-time — adding these never triggers a user re-auth): `im:message:send_as_bot`
(deliver the card), `im:message.p2p_msg:readonly` (**receive** DM commands `digest`/`done`/`snooze` — paired
with the `im.message.receive_v1` event), `im:chat:readonly`.

**Bot chat-interface setup** (one-time, app-level, **NOT per-user**): Event & Callbacks → subscription mode
**persistent connection** + add event **"Message received" (`im.message.receive_v1`)** + the DM-receive scope
**"Get direct messages sent to bot" (`im:message.p2p_msg:readonly`)** → **release the version** (approval ≠
release; a device-flow consent showing fewer scopes than expected = the version isn't live yet). **Trap:** the
event lists several "any one suffices" scopes, but each only delivers the message *type* it names — the **group**
scope does NOT deliver p2p DMs; you need the **DM** one.

**Dropped:** `im:message.send_as_user` — self-chat delivery deprecated; `SEND_AS` default flipped to `bot`
(2026-08-04). **Deferred:** `im:message.reactions:write_only` (R7 done-✅) — will be bot-side ⇒ publish-time, no re-auth.

Everything the old broad app once granted — `base:*`, `docx:*`, feed/pins/recall, chat
member/create/update, `contact:user:search`, reaction **write** — is simply **absent** on the
new app (never granted, nothing to trim).

**Consent is not automatic.** *Removing* scopes needs no re-consent; *adding a user scope* means
**every onboarded user must re-authorize** (device flow) — token refresh never picks up new scopes.
Only **user** scopes force this; **bot/tenant** scopes take effect on publish (no re-auth), so
future bot-side needs (R7 reaction-write, R13 bot menu) can be added freely. The 11-scope user set
above is **locked & verified** (2026-08-04) before cohort onboarding — R9's `contact:user.department`
is pre-folded so org-signal ships with no re-auth. **Setup order (per the launch):** add scopes +
**release** the app version → per user: `lark-cli config init` (once) + device-flow `auth login` →
verify on the token (`auth status` scope count = 11, incl. `contact:user.basic_profile:readonly`) → run.
**Naming traps that cost us cycles:** `contact:user.base` ("basic info") ≠ `contact:user.basic_profile`
("basic profile"); and the receive event's **group** scope ≠ the **DM** scope — match by exact code.

## Non-functional requirements

- **On-demand only** — no polling; a run happens when I trigger `digest` (or `npm run digest`).
  *(Relaxed by **R12**: a scheduled interval may also fire the digest. Still not event-polling —
  it's a timed re-run of the same on-demand pipeline; nothing is marked read.)*
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
  large backlogs — acceptable for an on-demand tool. The default is now **168h (7d)**,
  but the dominant cost is the watermark `--sender` scan over `WATERMARK_LOOKBACK_DAYS`
  (14d, unchanged), so widening the mention/DM window from 3→7d adds little; the common
  case stays bounded.
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

**Status (2026-06-24):** the Lark app is configured + approved in the dev console
(Bot enabled, scopes/publish handled), **but bot send is still blocked** — see the
blocker below. Decisions this session: **real bot** delivery surface + **curated**
beta auth (named users authorize once via a link; self-serve OAuth as fast-follow).
Pre-launch token guard: **✅ shipped**. Remaining crux once unblocked: the per-user
auth onboarding (below).

**⛔ Bot-send blocker (2026-06-24):** `SEND_AS=bot` fails `[11205] app do not have bot`.
Ruled out, in order: bot scopes (console shows enabled+approved), app secret (present +
valid — `doctor app_resolved` passes), publish/approval state (all approved, nothing
pending), stale local token cache (cleared, no change), CLI version (1.0.51 self-update
IT-blocked, but the error is a server-side semantic response, not a client crash).
Remaining cause by elimination: **tenant provisioning** — the app/bot is enabled+approved
in the dev console but not *installed / made available in the Traveloka workspace*, a
separate Lark-admin step. **Pending workspace admin.** `auth status` reporting bot "ready"
is misleading (token valid ≠ bot provisioned); the authoritative check is `lark-cli doctor`
→ `bot_identity`. Build resumes when that flips to `pass`.

**Pre-launch gate — token cost (✅ shipped 2026-06-24):** R6's thread bundling makes each
row bigger, and a stateless run re-summarises *everything* each time; the per-thread
**summary cache** (keyed by `thread_id` + newest `thread_message_position` + my watermark)
now lets repeat runs on unchanged threads cost ~zero Anthropic tokens. At multi-user scale
this was the dominant cost lever, so it gated launch — now closed. See the Shipped tracker
entry for mechanics (`threadCacheKey`, `THREAD_CACHE_TTL_HOURS`, per-user).

- **Implies:** bot capability activated (✅ confirmed 2026-06-17 — `232025` is
  gone), then the app must **apply the scopes + publish a version** (✅ done on Tessa's
  side, 2026-06-24). Scopes that were verified missing as of 2026-06-17:
  - *Send as bot:* `im:message:send`, `im:message`, `im:message:send_as_bot`
  - *Chat names + enumeration (labels + R1):* `im:chat:readonly`, `im:chat`,
    `im:chat.group_info:readonly`, `im:chat:read`
  - *(Event consumer for in-Lark `digest`/`done` commands will also want a message
    read scope, e.g. `im:message.p2p_msg:readonly` — confirm when we wire it.)*
  Reading mentions/DMs/reactions already works on the **user** token (no change).
- **Key design problem:** per-user auth — each teammate's digest needs *their own*
  user-identity context to read *their* mentions/DMs. Onboarding that without an
  IDE/CLI is the crux. To brainstorm next.

### R3 — Concise / expandable digest (should-have) ✅ shipped 2026-06-24

A busy digest is a wall of text: each row is header + AI summary + verbatim excerpt
+ a Jump button, so ~14 items overflow the card and stop being scannable. Make
detail collapse by default and expand on demand.

**As built (2026-06-24):** `buildCard.js` migrated from the v1 card schema to **v2
(`schema: "2.0"`)** — required because `collapsible_panel` is a v2-only component and a
card can't mix v1/v2. The **LOW / FYI** bucket renders inside a single collapsed
`collapsible_panel`; **HIGH + MEDIUM stay flat/expanded** (top-prio items are short and
actioned quickly, so collapsing them costs more than it saves). The panel header carries
the **count** (`🟢 LOW / FYI (N)`) so the collapsed state still tells you how many low
items exist; the existing `LOW_DISPLAY_LIMIT` cap + "+N more" line moved inside the panel.
No new env knob — the collapse target is fixed. Verified end-to-end by delivering a real
card to self-chat (`SEND_AS=user`).

- **Schema-migration mapping:** top-level `elements` → `body.elements`; `div`+`lark_md`
  text → standalone `markdown` elements; `action`+`button{url}` → standalone `button` with
  `behaviors:[{type:"open_url",default_url}]`; `wide_screen_mode` config → `update_multi`.
- **Gotcha (recorded in the limitations table):** **schema 2.0 dropped the `note`
  element** — the live send rejected it (`200861 … unsupported tag note`). The footer and
  the LOW "+N more" overflow line, both `note` in v1, are now `markdown`. `hr` survives.
- **Unverified residual:** the spike + ship were both on **self-chat (user mode)**. Bot-mode
  (`SEND_AS=bot`, the R2 surface) uses the same render engine so it should be identical, but
  v2 rendering there is formally unconfirmed — worth a 1-card check when R2 wires bot send.
- Fallbacks considered + not needed: show-more on the verbatim, or dense one-line rows.
- **Refinement (2026-07-02):** when LOW/FYI is the *only* bucket it renders expanded/flat, not
  collapsed — a lone collapsed bucket looked like the empty state. Cap still applies; collapse
  is unchanged whenever HIGH/MEDIUM are present. See the Shipped tracker entry.

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
- **Complement (R14):** the cc/FYI content R5 down-ranks is exactly what the end-of-day
  **Catch Me Up** brief surfaces *positively* — R5 detects/tags it, R14 gives it a home.

### R6 — Multi-message summary across the unread bundle (should-have; sharpened 2026-06-23, NEXT UP)

**Why this is the top priority:** the whole reason inlark exists is to decide whether
to respond *without opening the chat*. Today we collapse a chat to its latest unread
message and summarise only that one — so any multi-message ask is invisible until you
open it. Summarise the **whole unread bundle** instead. The unread set is exactly the
messages where `isUnread === true` (position > my watermark, or from 0 if I've never
posted — the position-0 fix makes "from 0" correct).

**The bundle, by surface (Tessa, 2026-06-23):**
- **DM:** all messages from *after my last sent message* through their latest — the
  unread run (or from the start if I've never replied). One row per DM.
- **Group @mention in a thread** (whether I'm @'d in the thread root *or* a reply):
  the unit is the **thread/topic**, not the chat. Summarise the thread's messages for
  context + **what I'm @mentioned for**. One row **per thread** — a busy group can yield
  several rows. *Rationale (Tessa): in groups, topics live in separate threads, so two
  messages in different threads are usually unrelated; bundling a whole group flat would
  mix topics.*
- **Group @mention not in a thread** (plain main-timeline @): nothing to bundle →
  single-message summary, as today.

**Decided:**
- Summary stays **≤15 words** even for a bundle (2026-06-23) → it must *lead with the
  actionable ask*, not enumerate. The verbatim `💬` line still shows the latest message.
- Grouping unit shifts from per-**chat** to per-**thread** for threaded mentions
  (extends R4's thread axis — likely a `dedupeByThread` alongside `dedupeByChat`).

**Settled as built (2026-06-24):**
- Thread bundle scope — **whole-thread context** (Tessa's pick), but the cost is tamed
  rather than paid in full: we fetch the thread, then send Claude only a **salient slice**
  (head + @mention neighbourhood + unread tail; cap + per-msg clip + elided gaps) so token
  spend stays ~flat per thread regardless of length — the key concern once colleagues use
  it. A fetch-on-demand gate skips the call for a lone, self-contained @-line.
- **Token guard before multi-user — deferred, tracked as an R2 pre-launch gate:** cache the
  per-thread **summary** (the expensive output, not the slice), keyed by `thread_id` + newest
  `thread_message_position` + my watermark. On a later run, if those are unchanged the thread
  is reused with **zero** Anthropic tokens (we reuse the stored answer, not regenerate). The
  Lark fetch is already token-free — it's re-summarising *unchanged* threads on every
  stateless run that compounds across users × runs. Not worth it single-user; add it **before
  exposing the bot** (R2). NB: the summary is per-user (framed around what *I* must do + my
  watermark), so the cache is per-user; only the raw thread fetch could be shared across users.
- **Feasibility — RESOLVED (spike 2026-06-24):** yes. `lark-cli im +threads-messages-list`
  lists a full thread's messages (accepts `om_`/`omt_`, resolves to `thread_id`,
  paginates); `+chat-messages-list` lists a full p2p/chat history; `+messages-mget`
  (≤50 ids) "expands thread replies". So whole-thread context is fetchable — the only
  open call is how *much* context to pull (see the bullet above), which has a
  privacy/cost dimension: thread context includes colleagues' messages that didn't @
  me, which today never leave Lark to the Anthropic API.
- **@all broadcasts:** kept as single-message + downranked (not bundled) — confirmed as built.

### R7 — Interactive per-item done/snooze (should-have, added 2026-06-18)

Replace the text-command `done 2 3` flow with **per-row buttons** on the card.
- **Feasibility spike first:** SPEC currently records "no card-button callbacks over
  the lark-cli WS bus" — re-verify, since Lark cards emit `card.action.trigger`
  events; confirm whether we can receive them (user vs bot identity). Likely couples
  to R2 (publish + scopes). **This same spike gates R13** (card refresh button + bot
  menu) — one card-callback plumbing change unlocks per-item done/snooze *and* a
  trigger button, so build them together.
- **State model (decided — option b):** a `done` click drops a ✅ **reaction** on the
  message (bot, on my behalf), so the existing reaction-rule treats it as addressed
  on the next run — per-item buttons **without** a growing `doneMessageIds` list and
  **without** losing the "never resurfaces" guarantee. Needs a reaction-write scope.

### R8 — Dynamic lookback window (added 2026-06-18; **interim shipped + fuller design parked 2026-07-02**)

**Interim shipped (2026-07-02):** default `LOOKBACK_HOURS` bumped **72h → 168h (7d)**. The window
is unchanged in kind — still a fixed *rolling* `start = now − LOOKBACK_HOURS` — just wider. Tessa's
call, and a good one: it captures **~80% of the value** of the fancier designs below for a one-line
config change, keeps the window a **user-varyable knob** (the ideal range is genuinely role-dependent
— an IC and a manager want different reaches), and avoids baking in non-obvious behaviour on an
unproven assumption. **Known residual it does *not* fix:** a rolling window still *slides*, so an
unaddressed @ still silently drops off the far edge after 7d — the original "did it drop, or did I
handle it?" perception. 7d just makes that edge rarer/further back. The *anchor* (below) is what
actually removes the slide.

**The fuller design — considered in depth 2026-07-02, deliberately deferred.** Two separable ideas
were on the table; keep both as pickups:

- **(A) Stable weekly anchor** — instead of `now − N`, anchor the window *start* to a fixed weekday
  boundary so it doesn't slide within a week. Settled shape (if we build it): **start = this week's
  Monday 00:00 − 3 days = the preceding Friday 00:00, local time** — resets each Monday (bounded
  backlog, clean "fresh week"), reaches back over the weekend + the Friday before (weekend @s can
  matter), and stays fixed all week (kills the slide). **Deferred because:** it encodes a "people
  clear within the week" assumption that may not fit every role, and the reset is *hidden* behaviour
  (a knob is more legible for now). Cheap to build later (a pure `triageWindowStart(ref)` helper);
  the 7d bump doesn't foreclose it.
- **(B) Persistent tracking** — remember every unaddressed @ and keep surfacing it until *explicitly*
  cleared (reply/react/`done`/`snooze`), with the time window only bounding a *cold* scan.
  **Rejected for the R2 launch** (not just deferred): it would dump a **huge backlog** on a new
  user's first digest (hostile onboarding for a "frictionless" bot), and read-but-never-cleared
  false positives (the "sureee" closers) would **pile up forever** instead of self-cleaning by aging.
  Tessa's counter that settles it: if an @ still matters, it gets **re-@'d / followed up**, so it
  re-enters on its own — a week of silence is itself the signal it resolved or didn't matter. So the
  time-window drop is *correct* behaviour here, not a trust breach.
- **(parked idea) Behaviour-inferred urgency decay** — an item's urgency naturally *sags* toward
  low as it goes unaddressed, then ages out. Elegant, but **too subjective to pin now** (how fast?
  per-role? per-category?). Revisit once we have real usage signal; the current window is a clean
  base to layer it onto.

Also shipped earlier as a quick phrasing fix (2026-06-18): the lookback label is date-only.

### R9 — Org-signal triage: department + reporting-manager (low-priority / good-to-have, added 2026-07-02)

Use the sender's **position in the org chart** as a triage signal, on top of the
existing urgency/category model. Intuition: a ping from my **reporting-manager chain**
(my manager, my skip, my directs) or from my **own team/department** usually deserves to
rank above an otherwise-identical message from a distant part of the org; "department
statistics" (how close the sender's department sits to mine) is a cheap relevance proxy
when the text alone is ambiguous.

- **How it'd compose:** a **bias input** to classification (like `is_broadcast`), not a
  hard reorder — nudges urgency, never overrides a genuine `high`. Likely a per-sender
  `org_relationship` feature (manager-chain? same team? same department? cross-org?) fed
  into the prompt + a card tag.
- **Data source / scope (folded into the pre-onboarding grant):** sender department +
  manager come from the Lark contact/org directory (`lark-contact`); reading them needs
  **contact scopes beyond today's identity-only `contact:user.base:readonly`** (department +
  manager fields). Because *adding* a scope forces **every already-onboarded user to
  re-authorize** (R2 scope note), these are now listed in the **least-privilege scope table
  above** so they're granted *before* the cohort — no re-auth wave. **Being built in a
  parallel session (2026-07-02):** confirm the final scope names there and reconcile the
  table row before we lock the grant. The org graph is near-static → cache the lookup hard.
- **Sensitivity:** this reads employee org data (reporting lines, department membership) —
  keep it strictly need-to-know, use it only to rank *my own* inbox, and don't surface
  anyone's manager/department on the card beyond what triage needs.
- **Open questions:** where the org signal ranks vs. @all / cc down-ranking; whether
  "department proximity" earns its keep beyond the manager-chain (the strongest signal on
  its own); how it composes with priority groups (R1, which is the other "relevance beyond
  a direct @" lever).

### R10 — Mute-aware triage (low-priority / good-to-have, added 2026-07-02)

Chat **mute/DND is the strongest explicit signal Tessa gives** — "I've decided I don't care
about pings here." inlark ignores it today; she compensates manually by dismissing @all from
muted chats. Honouring it (drop, or hard-downrank, @s from muted chats) would automate that
and generalise better than the hardcoded noise-name list (`isExcludedChatName`,
[config.js](src/config.js)), which only fires when a chat name resolves.

- **Feasibility spike FIRST (gates everything below):** is per-user chat mute status even
  queryable? Mute is a client-side notification preference — same family as the unread badge
  the [limitations table](SPEC.md#L398) records as **not exposed via API**. It's *not* on the
  `messages-search` payload, so at best it needs a separate per-chat settings lookup with an
  unproven scope, and it may not exist at all. Don't design further until this is answered.
- **If queryable — design questions:** **downrank vs. drop** — a muted chat can still carry a
  real direct @me that matters, so a blanket drop risks a false negative; hard-downrank is
  probably the safer default (drop only for @all-in-muted). How it composes with the existing
  @all / cc down-rank. Mute is *my* preference ⇒ **per-user by construction**, so it fits the
  R2 multi-user model (per-user lookup + cache the near-static result). Any new scope ⇒
  re-consent — fold into the pre-onboarding grant (like R9) if it lands before the cohort.
- **Why low-prio:** the bot/app sender drop + noise-name list + @all collapse already dark
  most of these chats; this closes the residual (a human @all / @me in a muted human channel)
  and swaps a brittle hardcoded list for an explicit user signal.

### R11 — Alert-channel urgency pass (low-priority / good-to-have, explore-first, added 2026-07-02)

**The inverse risk of a deliberate decision.** Automated senders are dropped hard — the
`{bot, app}` in-code filter (`passesSenderFilter`, [fetchMentions.js](src/fetchMentions.js)) and the
noise-name list (`isExcludedChatName`, [config.js](src/config.js)) — all built to kill release/alert
spam. But the canonical **HIGH** case (incident / outage / paging) can arrive *from* a bot or app,
so the blanket drop had a false-negative hole.

**✅ Partly closed (2026-07-14):** a bot/app that **@mentions me directly in a group** is now **kept**
(`passesSenderFilter` — the direct-@me carve-out), because a workflow/booster app naming me by open_id
is a real ask. Live this rescued ~12 direct-@me app pings/7d (the activity-ops booster: refunds, failed
issuance, same-day escalations) that the old blanket `--exclude-sender-type` drop was silently eating.
This is the **stronger, cleaner rule** than the options below — structural (is my id in `mentions[]`?),
no relevance heuristic, no cap needed.

**Residual (still R11):** an incident a bot **broadcasts** to an alert channel with **no direct @me**
still drops — the carve-out can't catch it (my id isn't in `mentions[]`). That's the firehose case, and
the volume tension still applies to it.

The tension is **volume** — those channels are firehoses (that's *why* they're dropped), so the fix
can't be "stop dropping them"; it needs a relevance gate + cap or it reintroduces the noise we
removed. Approaches to weigh (not decided):
- **(a) Critical-channel allowlist** — the inverse of the noise list; named alert channels bypass
  the bot/app drop, then AI classifies and we surface **only HIGH**.
- **(b) Severity keyword pass** — scan otherwise-dropped automated messages for
  `SEV1`/`P1`/`outage`/`down`/`paging` and rescue just those.
- **(c) Classifier-decides** — let the `incident` category do the work, with a hard cap so a noisy
  night can't flood the digest.
- **Composes with:** R1 (priority groups — the other "relevance beyond a direct @" lever) and R10
  (mute — a muted alert channel is a strong "don't rescue" signal).

**Consider before build** (Tessa, 2026-07-02) — needs design, not just a flag.

### R12 — Beta scheduling & host: unattended digest, laptop-only (self-beta, added 2026-07-02)

Run inlark for myself **unattended** — the digest arrives on a schedule and the bot's command
listener stays up — without manually kicking off `npm run …`. Single-user (me) first; generalises
to per-user under R2.

**Host decision (2026-07-02): laptop-only, awake — no always-on host yet.** A closed-lid MacBook
sleeps, so scheduled jobs don't fire and the `listen` WS drops. Workarounds were weighed and
rejected for the beta: clamshell mode (needs a dock), `sudo pmset -a disablesleep 1` (admin —
often blocked on a managed Mac — plus battery/thermal cost running in a closed bag), and
`caffeinate` alone (does **not** override lid-close sleep). The VPN also drops the WS regardless
(see memory). So the beta simply **runs only while my laptop is awake** — good enough to start
trying it. The reliable always-on version is **deferred to R2 item (4)** ("always-on host for the
event listener"); R12 is explicitly the stopgap before it. Use **`launchd`, not `cron`**: launchd's
`StartCalendarInterval`/`StartInterval` **run a missed job on next wake**, which is exactly
"when the laptop is awake" semantics; `cron` silently skips anything scheduled during sleep.

**Cadence decision (2026-07-02): fire the digest on a fixed interval, default hourly — as a new
user-facing env knob.** The stateless re-surfacing (every run re-pushes the current backlog — a
run marks nothing read) is **not a concern here**: Tessa's incoming-message frequency means the
card genuinely differs most hours, so no change-gate build — just push on the interval. Frequency
is a **per-user env var** (people want different reaches) — e.g. `DIGEST_INTERVAL_MINUTES`
(default 60). Daily start anchor **10:30am** (office arrival; was 8am).

**Proposed architecture — fold the scheduler into the listener (one supervised process):** instead
of a separate `cron`/`launchd` job racing the listener, have the **`listen` process self-trigger a
digest on an internal interval** read from the env knob. This (a) makes frequency a true runtime
var, (b) routes the scheduled digest through the **existing per-listener in-flight guard**, so a
timer-fired digest and a manual `digest` can't overlap and trip Lark's `99991400` frequency limit
(the separate-cron overlap risk), and (c) leaves **one** process for `launchd` to supervise —
`RunAtLoad` + `KeepAlive` (start on login/wake, restart on crash) with a `ThrottleInterval` so
rapid restarts don't themselves trip `99991400`. Delivery stays **self-chat (`SEND_AS=user`)** —
works today, no bot provisioning; the bot surface is the R2 upgrade.

**Open questions:**
- **Start trigger:** launchd `StartCalendarInterval` at 10:30am vs. `RunAtLoad` on login/wake
  (fires whenever I open the lid, incl. WFH). Login/wake is simpler and more "when I'm actually
  working"; 10:30 is more predictable. Lean login/wake + RunAtLoad, revisit.
- **Interval-knob shape:** a plain `DIGEST_INTERVAL_MINUTES` vs. a working-hours window (e.g. skip
  8pm–8am) so it doesn't keep firing all night while the laptop's awake-but-idle. Start plain; add
  a window later if the after-hours pushes annoy.
- **Internal timer vs a 2nd launchd interval:** internal `setInterval` (env-driven, shares the
  in-flight guard) is preferred over a separate launchd `StartInterval` for the reasons above —
  confirm at build.
- **Supervision UX:** how I see it's alive / restart it without an IDE (a `doctor`-style status? a
  menubar item?) — matters more once it's meant to be unattended.

**Not building yet — captured on Tessa's call (2026-07-02).** Graduates to the tracker when built.

### R13 — In-Lark interactive triggers: refresh button + bot menu (added 2026-07-09)

Today the only way to (re)trigger a run is typing `digest` (bot mode) or `npm run digest`
(CLI). Tessa wants a **click-to-refresh** affordance — a button on the digest card — and asked
whether Lark offers something more menu-like (à la Telegram's bot menu / button menus). It does;
here's the landscape and the pick.

**Lark's native trigger surfaces (how they map to "Telegram menus"):**
- **(a) Card callback button** — a `button` on the digest card whose behavior is a **callback**
  (not `open_url` like our Jump button), emitting a **`card.action.trigger`** event that carries a
  `value` payload (e.g. `{action:"digest"}`). This is the "button after each digest" Tessa pictured:
  contextual, **zero dev-console config**, reuses the existing digest pipeline.
- **(b) Persistent bot menu** — a fixed menu configured on the bot in the **dev console** (Tessa's
  side), shown at the bottom of the DM with the bot; a click emits an **`application.bot.menu_v6`**
  event. The closest analog to Telegram's persistent menu: **always available, independent of scroll
  position or which card is latest**. Good for "trigger from anywhere, anytime"; holds a few fixed
  entries (Digest / Help). Can't reference card state, so it can't do a per-item `done 2`.
- **(c) Slash / inline commands** — Lark has **no** third-party equivalent of Telegram's inline
  slash-command system; (a) and (b) are the real options. (Noted so we don't hunt for a feature that
  isn't there.)

**Recommendation — start with (a), the card `↻ Refresh` button.** It's the ~80% win: contextual, no
console config, and — the key point — it **rides the same card-callback plumbing R7 needs** (per-item
done/snooze buttons). One spike unlocks both, so build the refresh button *alongside* R7, not as a
separate effort. The **bot menu (b)** is the better "anytime" surface and — **confirmed by Tessa
(2026-07-09) as the planned iterative improvement over (a)** — ships as a deliberate *second* step:
card button first, then layer the menu on. It costs dev-console config + a *second* event type to
consume/verify and couples to R2 (bot provisioning), so it's intentionally kept out of the first spike,
not part of it.

**⚠️ Shared gate with R7 — why this isn't independently "quick":** both (a) and (b) need **callback
events over the lark-cli WS bus**, still listed as *unverified* — we consume only
`im.message.receive_v1` today, and `done`/`snooze` are text commands for exactly this reason. So R13's
button is **not a standalone quick add**; it's gated on R7's feasibility spike ("can we receive
`card.action.trigger`?"). Prove that once and the refresh button, per-item done/snooze, and (with
console config + the bot-menu event) the bot menu all become available together.

**Design notes (once the spike passes):**
- Button emits a callback → the listener routes `value.action === "digest"` to `runDigest`, reusing the
  **in-flight guard** so a double-tap can't trip Lark's `99991400` frequency limit (same guard the text
  `digest` uses today).
- No message-patch API → a refresh **posts a fresh card** (like the `done`/`snooze` re-render), it
  doesn't edit the old one in place. Tapping refresh on a *stale* card is harmless — the pipeline
  re-fetches current state, so it's always "latest", never a replay.
- The button does **not** "type digest for you" — it's a callback event, not a synthesized user message
  (clarifying Tessa's "send digest" phrasing: the mechanism is an event, not text).
- Ack UX: acknowledge the callback (toast / loading state) so the tap feels responsive while the burst runs.

**Open questions:** does the lark-cli WS bus actually surface `card.action.trigger` /
`application.bot.menu_v6` (the R7 spike answers the first)? user vs bot identity for the callback? does a
bot-menu config force a re-publish / new scope (fold into R2's scope lock)? **Not building yet — captured
on Tessa's call (2026-07-09); graduates to the tracker when the R7 spike lands.**

### R14 — End-of-day "Catch Me Up" brief (good-to-have, added 2026-07-20)

The LOW/FYI bucket is *real value*, not noise — cc's, @all's, routing notes, status updates: things
Tessa doesn't have to **act** on but wants to **know**. Today they're correctly down-ranked (collapsed
panel, per-item `FYI:` summaries), but the digest is optimised for *"what must I do"*, so across a day
the awareness content piles into a long, un-synthesised LOW list and gets scrolled past. (The 2026-07-20
"list every LOW item, no cap" change makes this sharper — nothing's hidden, but the tail is now longer.)
Give that content its own home: a **once-a-day, glanceable "here's what happened around you" brief** —
the digest's mirror image (*what to know* vs *what to do*), same actor-relative model, opposite end.

**The distinction that makes it a separate artifact — synthesis, not a re-list.** The win is *not*
"expand the LOW panel at 6pm." It's **distillation**: cluster the day's FYI into a few themed lines
("2 warehouse routing notes; Project X shipped; 3 @all's — offsite RSVP, policy update, comp cycle"),
each with a jump, instead of N verbatim rows. If it's the same list re-posted, it hasn't earned its
place — a *briefing* is the point.

**Pragmatic first cut (~80% value, no new deps):** an **on-demand `catchup` command** that takes the
current LOW/FYI set (already fetched + classified + summary-cached by the digest pipeline) and posts
**one synthesised brief card** — one extra synthesis call *over the cached per-item summaries*, so cheap.
Ships today, **no host needed**, testable in self-chat like everything else.

**Full version (rides R12):** scheduled **end-of-day auto-delivery** (~6pm, new knob) so it arrives
unprompted. Depends on R12's host + interval plumbing — fold the daily brief in as a *second cadence*
alongside the hourly digest (a daily timer beside the hourly one, same in-flight guard).

**Design decisions / open questions:**
- **Content scope (the key fork):** *only cc'd items* (Tessa's literal ask — narrowest; needs R5's cc
  detection) vs. *the whole LOW/FYI bucket* (broader: cc + @all + routing + status). **Lean: whole
  LOW/FYI bucket** — it's exactly "no action needed from me," which *is* the keep-me-informed set; cc is
  just its most obvious member. **Confirm with Tessa.**
- **Window:** the digest's 7d *rolling* window is wrong here — a daily brief wants **today only** (since
  this morning) or **since the last catch-up**, else it re-briefs the same week every evening. A small
  day-scoped variant on the lookback, *not* the stable-anchor debate (R8).
- **Synthesis vs list:** cluster by theme / project / chat into a few lines, not one row per item. Costs
  one extra Claude call over the cached summaries (cheap) — note for the R2 token budget.
- **Composition with the digest:** complement, don't duplicate — the digest keeps its inline LOW panel
  for same-run "why it's low" transparency; the brief is the end-of-day *synthesis*. **Forward idea (do
  not decide now):** once the brief exists, the main digest *could* shed its long LOW tail and delegate
  awareness to the brief — a real simplification, but only after the brief proves itself.
- **Depends on:** R5 (cc detection, if we go cc-only) + R12 (host, for the scheduled cut). The on-demand
  `catchup` cut depends on **neither** — build it first.

**Not building yet — logged on Tessa's call (2026-07-20). Graduates to the tracker when built.**

---

## Out of scope (for now)

True unread (blocked by Lark API — see the limitations table), in-place card
editing, keyword filters (`digest urgent`).
*(Multi-user and "run without an IDE" are **R2**; scheduled / fixed-interval auto-delivery is now
**R12** — all no longer out of scope.)*
