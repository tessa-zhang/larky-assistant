# inlark — handover notes

> Written for the AI assistant picking this project up from Claude. Tessa is
> switching the collaborator to ChatGPT; this file is the context you'd
> otherwise inherit from Claude's private memory folder (outside the repo).
> Read it *after* [CLAUDE.md](CLAUDE.md) and the **Requirements & progress
> tracker** at the top of [SPEC.md](SPEC.md).

> **Codex pickup update (2026-10-13):** the WIP described below has now been
> reviewed and committed in logical slices. Classification uses LiteLLM's
> OpenAI-compatible endpoint via `fetch` (the Anthropic SDK is gone), persistent
> thread-summary caching was removed, and `lastDigest` is encrypted at rest.
> Sections 4(d/e) and 7 record the historical handover state; current behavior
> lives in SPEC.md and the implementation.

---

## 1. Who you're working with

**Tessa Zhang** — PM at Traveloka (an OTA), product owner of inlark. Treat the
relationship as **founder-type and equal**: push back, propose better designs,
flag risks early. She dogfoods inlark as her real daily triage tool, so
correctness bugs hit her actual workflow.

**How she iterates — the shortest version:**

- **Prefers the trivial ~80% solution early**, before anything clever. When a
  task has a fancy and a one-line version, name the one-line version first and
  quantify the gap. Example: R8 lookback shipped as a `72h → 168h` default
  bump; the Monday/Friday week-anchor she'd floated is still a parked roadmap
  note. R20 "flag substantive replies" shipped as a single
  content-density signal, not thread-aware Q&A detection.
- **A "no, not that" on a structural option isn't necessarily durable** — it
  often means *not yet, try the cheap thing first*. If the cheap fix fails,
  **re-offer the rejected option** rather than inventing a third thing. The
  bot/human split shipped on exactly that pattern — rejected pass 1, became
  the answer in pass 3.
- **Measure against her real inbox before making a signal a rule.** Live data
  changed the design twice: tag-position is confounded for her (position 2
  in 47/94 direct @s due to `activity-ops` templates); the "getting crazy"
  volume was bots, not LOW existing.
- **She frames changes as experiments** ("for now", "then we'll get user
  feedback") — bias toward reversible implementations and say what the revert
  lever is.
- **She wants live evidence, not inferred fixes.** Reproduce from her real
  state/live data; distinguish *conscious design* (e.g. @all kept and
  downranked) from *bug* before touching code.

---

## 2. What inlark is (one paragraph for grounding)

Personal → beta-team Lark triage bot (Node + `lark-cli`). Scans the user's
unread @mentions and DMs in a fixed rolling lookback window, classifies by
urgency with Claude (via Traveloka's LiteLLM proxy — see §4), delivers one
interactive v2 card the user acts on via `done` / `snooze` text commands.
Current direction (R2) = **hosted bot** so colleagues can use it without an
IDE. SPEC.md is the living source of truth; the top-of-file **Requirements &
progress tracker** is "where we left off."

Current app: **`cli_aacf7cc512b8ded2`** (profile name **`larky`**) — a
least-privilege R2 app built from scratch, locked to **11 user-consent scopes**
+ bot chat-interface. Not a trim of the old broad `cli_aaaba7cf9a211ed1`.

---

## 3. Core product tenets (hard-earned — don't relitigate)

### Triage is relative to the user, not topic severity

Priority = "what must *I* do", not the message's intrinsic drama. A high-stakes
incident that only cc's her is LOW *for her*. "Named ≠ asked."

### Never make urgency a visibility gate

`urgency: 'low'` groups and orders, it never hides. The **action-only
digest** (`urgency !== 'low'` filter for humans) was tried **2026-08-11** and
reverted the same day. Two things broke under a gate:
1. **Recoverability** — a mis-classified `low` became invisible. Normally
   collapsed-but-present means a wrong call is still clickable.
2. **The classify fallback** — had to move `low`/`fyi` → `medium`/`question`,
   because with no API key *every* item falls back and would produce an empty
   digest. Both now restored. **If urgency ever becomes a gate again, change
   the fallback with it.** A regression test asserts a human `low` row still
   ships.

### Transparent "why it's low" > silent hiding

The per-LOW **`FYI: <why it's low>`** summary line is load-bearing — it reads
as *assurance nothing is being missed*. Removing it reads as hiding.

### Bot/app items live in their own section — and are exempt from any filter

Three iterations in one day (2026-08-11) to get here:
- **🤖 BOT / APP collapsed panel at the bottom** of the card.
- Human-first ordering: every human sorts above every bot
  (split → urgency → recency).
- Lone bot section (no humans) renders flat, not collapsed.
- A thread's row is anchored to the **latest human direct-@me** when one
  exists, not the latest replier (`pickRepresentative` in
  [src/fetchMentions.js](src/fetchMentions.js)). Without this, a workflow bot
  replying last would steal the sender/excerpt/jump/bot-classification of a
  human's actual ask.

### A real person naming her always wins

This class of regression has been fixed three times (sender-filter 2026-07-14,
noise-channel 2026-07-02, representative anchor 2026-08-11). Don't re-break it.

### Directedness is classifier evidence, not a sort key

`normalize()` reads two facts from `mentions[]`: `taggedCount` and
`myTagPosition` (1-based slot). Rows carry the bundle's **strongest**
directedness (`strongestTag`). It feeds the prompt — not ordering.

**Position is explicitly the weakest signal** (it's confounded for her — see
§1). **Breadth** discriminates well: 1–2 ≈ genuine asks, 3–4 ≈ team asks,
9–23 ≈ release notes / dashboards. The prompt says *"judge relative to the
chat — a 5-person squad differs from a 200-person channel"* — no absolute
thresholds, no per-user config.

### Verified Lark fact: `mentions[]` and `@all`

`mentions[]` is ordered in text order with explicit ordinals in `key`
(`@_user_1`, …). It contains **only individually-named users**. A pure `@all`
returns **no `mentions[]`** at all. An `@all` mixed with individual tags
lists only the individuals (so `mentions[]` can be non-empty while her id is
absent — the existing `isBroadcast` test still holds).

---

## 4. Load-bearing operational gotchas

The checklist of "will burn you if you don't know."

### a) VPN breaks Lark connectivity

**Why:** Tessa's company VPN caused Lark WebSocket + API timeouts
(2026-06-30). `lark-cli doctor` was all green at the time — because it was
network, not a token/scope issue.

**How to apply:** if timeouts, WS drops, or "API call failed" recur with
doctor green, **suspect the VPN first** before deeper debugging. This also
justifies the **self-healing listener (auto-reconnect + backoff)** and
retry-with-backoff in the lark-cli wrapper — keep them in scope; beta users
are colleagues on the same corporate VPN.

### b) `lark-cli` profiles are machine-global; always pass `--profile larky`

**Why:** `lark-cli` stores apps in `~/.lark-cli/config.json` behind one
machine-wide `currentApp` pointer. On 2026-09-10 that pointer silently flipped
from `larky` (inlark's locked R2 app) to `main` (the old broad
`cli_aaaba7cf9a211ed1` with `base:*`/`docx:*`/`drive:*`/`wiki:*`/`mail:*`).
inlark had been following whatever was globally active.

**How to apply:** every `lark-cli` call inlark makes carries `--profile larky`
explicitly (via `LARK_CLI_PROFILE` in [src/config.js](src/config.js) threaded
through `runRaw` in [src/lark.js](src/lark.js) and the `event consume` spawn in
[src/index.js](src/index.js)'s `cmdListen`). If a scope/identity error ever
looks wrong given the locked 11-scope set, check `lark-cli profile list` /
`lark-cli auth status` for which app is actually active **before** suspecting
inlark's code.

### c) `.env` is access-restricted — override inline

**Why:** `.env` holds `ANTHROPIC_API_KEY` and behavioural knobs. The project's
sandbox denies reads/writes to it. `.env.example` is readable; `.env` is not.

**How to apply:** either (a) ask the user to edit `.env`, or (b) override
inline for a one-off run — `LOOKBACK_HOURS=72 npm run digest`. Dotenv does
**not** override already-set `process.env` vars, so inline wins over `.env`.
**Do not** sed/circumvent the restriction — it protects secrets and bypassing
is a data-access violation. Keep `.env.example` in sync when defaults change.

### d) LiteLLM model name must match the key's allow-list

**Why:** classify silently fell back to `low`/`fyi` for every item (2026-09-10)
because the LiteLLM virtual-key's model allow-list uses **LiteLLM's own
naming**, not Anthropic's raw id. `claude-sonnet-4-6` (no suffix) 403s with
`key_model_access_denied`; the key wants `claude-sonnet-4-6@default`,
`claude-sonnet-4.6`, or `claude-sonnet-5`.

**How to apply:** current default is **`claude-sonnet-5`** (in
[src/config.js](src/config.js) and `.env.example`). If classify ever fails
this way again, check `.env`'s literal `CLAUDE_MODEL` value **FIRST** — not
just the code default. The 403's error body lists the full allow-list — fastest
way to pick a valid id. Verify any candidate with a live
`client.messages.create()` call before setting it.

**Note for the GPT handover:** [src/classify.js](src/classify.js) uses the
`@anthropic-ai/sdk` pointed at LiteLLM's Anthropic-compatible passthrough.
Because LiteLLM is OpenAI-compatible too, switching to GPT models *shouldn't*
require abandoning this file — but you'll need to:
1. Verify LiteLLM exposes an `/v1/chat/completions` route (OpenAI-shape) at
   the same host, OR confirm it will route a GPT model id through its
   `/anthropic/*` Anthropic-shape endpoint.
2. Confirm the chosen GPT model id is on the virtual key's allow-list before
   changing `CLAUDE_MODEL` (misnomer now — rename if you touch it).
3. Re-tune the prompt in `classify.js` — it was shaped for Claude JSON output.
   No prompt caching is in use; drop it from mental model.

### e) The classify fallback used to poison the thread-summary cache

**Why:** the per-thread summary cache (R2 token-saving) is keyed by
`thread_id` + newest position + watermark. `fallback()`'s degraded output
(`{urgency:'low', category:'fyi', summary:<truncated text>}`) is
shape-identical to a real classification — so during the ~2-week model
misconfig, every thread that got a fallback had that fallback cached as if
real. `getCachedSummary` refreshes `savedAt` on every hit (to keep live
threads warm), so a poisoned entry never ages out via TTL — not a 14-day
problem, a **forever** problem until the thread itself changes.

**How to apply (already fixed):** `classify.js` tags every result
`fallback: true` or `fallback: false`. `commands.js` only calls
`setCachedSummary` when `!c.fallback`, and strips the marker before the
persisted digest snapshot. **If classification looks broken AFTER a root
cause was already fixed and verified live, suspect this cache before
re-diagnosing classify** — check `state/<open_id>.json`'s
`threadSummaryCache` for `fallback()`-shaped entries with recent `savedAt`.
The fix prevents **future** poisoning; it does **not** retro-clean entries
from before the fix. A one-off purge is sometimes needed.

### f) `npm run listen` output is invisible from outside its terminal

**Why:** it runs in Tessa's VS Code integrated terminal — no `/proc` on macOS,
`ps -E <pid>` only shows env not log output. The `[classify]` error lines
(the `describeError()` output distinguishing network/HTTP/parse failures) are
only visible in that terminal.

**How to apply:** to actually see what's happening, kill + relaunch with
logging:
```
kill <pid>              # ps -eo pid,command | grep "index.js listen"
nohup npm run listen > /tmp/inlark-listen.log 2>&1 & disown
```
Then tail that log. This is the only way to distinguish a *silent*
no-credentials fallback (classify's early return when key/base-url is falsy —
logs nothing) from a *logged* chunk failure vs. something else.

**Observed unresolved (2026-09-24/25):** right after a restart, one `n`
trigger returned 19/20 fallback-shaped with no `[classify]` log line — the
no-credentials fingerprint, except env was fine. Next trigger clean, stayed
clean. Suspected one-off cold TLS blip on first live request. If "unclassified
digest right after a restart" recurs, use the diagnostic above and consider
a warm-up call or retry-once — **but don't build that until it's reproduced
with a captured error**, not inferred.

---

## 5. Privacy model (R16 — read this before building anything multi-user)

**Tessa's bar:** *"I as the developer can never access message content;
never store any message content or expose it to anyone besides the user
themselves."*

**The structural fact (don't relitigate):** if a process reads user U's
inbox while U isn't present, on infra the developer controls, the developer
*has* that capability. At-rest encryption doesn't remove it (the key must be
available to the process that decrypts). "We don't log it" is policy, not
guarantee. Only three ways out: self-host per user, a TEE/confidential
compute, or don't do hosted multi-user.

**Decision (2026-08-17):** custodial, because Tessa ruled out self-host
(*"i don't want them having access to this repo"*). The SPEC guarantee is
scoped **honestly**:

- ✅ **No message content at rest, anywhere** — content in RAM only during
  a user-triggered run.
- ✅ **No cross-uid exposure** — delivery target derived from the *token
  owner's* open_id, never from the event; token-owner-vs-sender mismatch
  hard-refuses.
- ✅ **Adversary-hardened** — HMAC'd filenames + ids, no content in logs,
  nothing content-bearing in git.
- ❌ **NOT** "operator is cryptographically blind" — irreducible without a
  TEE. Say this to the first beta user rather than over-claiming.

**Finding that corrected R17 (2026-08-17):** state used to persist
`lastDigest.items[].text` (verbatim message body, 998 chars observed live)
+ 37 plaintext AI summaries + 42 message ids under
`state/<open_id>.json`. Fix designed: HMAC(open_id) filename,
HMAC(message_id) for suppression lists, digest snapshot + summary cache
**in memory only**, content-free `digestRefs` (card number → hashed id)
persisted so `done 2` survives a restart. **Deliberate cost:** a restart
loses the warm R2 summary cache ⇒ one run of re-classification. Chose that
over encrypting content-derived data at rest.

**Anthropic (now LiteLLM) key is a real gate, separate from anything we
build.** `classify.js` sees *every* fetched message on every run,
unattended. For hosted multi-user it **must** be Traveloka's company
LiteLLM / Anthropic org — not a personal account. No company LiteLLM
gateway existed when R16 was written (2026-08-18); the pilot branch now
assumes `https://litellm.tvlk.cloud` as the IT-approved target.

**Dry-run unblockers:** run e2e on Tessa herself through the multi-user
path (her content + her key = zero policy surface), or onboard with no API
key — classify falls back to `medium`/`question` and nothing leaves Lark.

**Status today:** any non-owner DM to the bot gets **silence**
(`index.js`: `senderId !== self.openId → return`). Whether colleagues can
even reach the bot depends on the app's admin availability setting.

---

## 6. R2 multi-user — the lark-cli situation

### What's blocked

The SPEC's original R2 plan — "each user = a lark-cli profile, per-command
`--profile`" — is **dead**. Verified 2026-08-05 with lark-cli 1.0.51:
- `profile add` rejects a duplicate app-id → can't give teammates profiles
  of the same inlark app.
- lark-cli models **single active user per app** — `--as` is identity
  *type* (user/bot), not *which* user; no per-command user selector.

### What works instead

**Isolated `HOME` dirs per user (verified 2026-08-17).** The
single-active-user limit is **per config dir**, not per app. lark-cli
resolves its config dir from `$HOME`, so `HOME=<dir> lark-cli …` gives a
fully independent config. Verified: `HOME=/tmp/probe lark-cli auth status`
→ `not configured` with its own `.lark-cli/` while the real home still
reported Tessa's valid token.

⇒ Multi-user = one isolated home per user (`config init` + device-flow
`auth login` inside it, same app id), then every per-user read runs with
that `HOME`. **lark-cli keeps owning refresh — no OAuth implementation, no
custom token store, no direct HTTP.** ~50 lines threading a `home` option
through `runRaw`. Bot-side calls (event consume, send) stay on the default
home — they're app-level.

**Caveat:** this relies on Go's `os.UserHomeDir` reading `$HOME`
(undocumented). Add a startup assertion that the isolated home resolves.

### Tokens aren't in `~/.lark-cli` — they're in the macOS login keychain

Addressed per `app_id + open_id`. A full `find` over `~/.lark-cli` shows
no credential file at all — only `config.json`, `cache/`, `events/`,
`locks/`, `logs/`. App secret likewise (`{source: keychain,
id: appsecret:<app_id>}`).

**Consequences:**
- Isolated HOMEs separate *config + routing*, **not** the credential store
  — every onboarded user's refresh token lands in the owner's keychain.
  **This is not a confidentiality boundary against the operator.**
- Since one keychain serves all users, a **token-owner assertion**
  (`resolved open_id === expected uid`, hard-refuse on mismatch) is
  **load-bearing** on every per-user call.

### The locked scope set (don't widen without re-approving)

**11 user-consent scopes** — all read/org/refresh, no user-send:

```
search:message
im:message.group_msg:get_as_user
im:message.p2p_msg:get_as_user
im:message:readonly
im:message.reactions:read
im:chat:readonly
contact:user.base:readonly
contact:user.department:readonly         (pre-scoped for R9)
auth:user.id:read
offline_access
contact:user.basic_profile:readonly
```

**Bot/tenant scopes** (publish-time, no re-auth):
`im:message:send_as_bot`, `im:message.p2p_msg:readonly`, `im:chat:readonly`.

**Hard-won gotchas (cost ~4 approval rounds):**
- `contact:user.basic_profile:readonly` (console label "basic profile")
  resolves sender open_ids→names in enrichment — **hard-required, no skip
  flag**. **Different scope** from `contact:user.base:readonly`
  ("user's basic info"), which is **insufficient**. Add by **exact code**,
  not console label.
- The receive event's "any one suffices" scope list gates by message
  **type** — the **group** scope ≠ the **DM** scope
  (`im:message.p2p_msg:readonly`).
- **Approval ≠ release.** A device-flow consent showing fewer scopes than
  expected means that app version isn't live yet — release it.
- `offline_access` refresh window is **~7 days** ⇒ a user idle >7d must
  re-login (hit live 2026-07-29). Open_id stable across re-auth.

**Only USER scopes force re-auth (device flow); bot/tenant scopes are
publish-time.**

---

## 7. What's in flight (branch state)

**Current branch:** [`pilot/configurable-inference-endpoint`](src/) — 1 commit
ahead of main (`933c221 Add configurable inference endpoint (ANTHROPIC_BASE_URL)`),
with **14 modified files + 3 new** (`src/crypto.js`, `src/scheduler.js`,
`src/users.js`) **uncommitted** at handover.

**What the committed change does:** adds `ANTHROPIC_BASE_URL` env var so
classify can route through LiteLLM instead of `api.anthropic.com` directly.
`.env.example` was flipped to prescribe
`ANTHROPIC_BASE_URL=https://litellm.tvlk.cloud`.
`ANTHROPIC_API_KEY` is now the **LiteLLM virtual key** (sent as a Bearer
token in the Authorization header — X-Api-Key 401s there).

**What the uncommitted WIP looks like (not yet reviewed in detail by this
handover):** `src/crypto.js`, `src/scheduler.js`, `src/users.js` plus
substantial changes to `src/index.js` (+239 lines), `src/config.js`
(+62/-23), `src/state.js` (+79/-79), tests (+254/-83), and SPEC.md
(+487/-20). This is almost certainly the R2 multi-user Phase 2 scaffolding
(users registry, scheduler, HMAC crypto for the privacy fix) — verify
against [SPEC.md](SPEC.md)'s current state before shipping. **Decide with
Tessa whether to commit, stash, or finish-and-commit before you make any
behavioural changes.**

---

## 8. SPEC.md / AGENTS.md drift to resolve

- [AGENTS.md](AGENTS.md) says *"classifies with Codex"* while [CLAUDE.md](CLAUDE.md)
  says *"Claude"*. One of them is wrong. If GPT becomes the collaborator,
  AGENTS.md may actually be the right one to keep (and consolidate CLAUDE.md
  into it).
- The `[1m].codex/config.toml` is already scaffolded with `.env` denied — good,
  reuse it.
- Rename `CLAUDE_MODEL` → `CLASSIFY_MODEL` or similar if you re-tune for GPT,
  so the env name doesn't lie.
- The prompt in [src/classify.js](src/classify.js) is shaped for Claude JSON
  output. Re-tune for the GPT model's JSON-mode behaviour; drop any
  Anthropic-specific framing.

---

## 9. The index — where everything else lives

- [SPEC.md](SPEC.md) — authoritative requirements + progress tracker at the top.
- [CLAUDE.md](CLAUDE.md) — session brief; founder-type working relationship.
- [AGENTS.md](AGENTS.md) — short alternative brief (drifted; see §8).
- [README.md](README.md) — usage docs.
- [.env.example](.env.example) — knob documentation.
- [`src/classify.js`](src/classify.js) — classification; LiteLLM-aware.
- [`src/fetchMentions.js`](src/fetchMentions.js) — unread detection, bundling,
  `pickRepresentative`, directedness extraction.
- [`src/commands.js`](src/commands.js) — digest / done / snooze, summary cache.
- [`src/buildCard.js`](src/buildCard.js) — v2 card schema, collapsible panels,
  bot section.
- [`src/lark.js`](src/lark.js) — lark-cli wrapper, `--profile` threading.
- [`src/index.js`](src/index.js) — commands, listener, target selector.
- [`src/state.js`](src/state.js) — per-user state partition.
- [`src/config.js`](src/config.js) — env knobs; `LARK_CLI_PROFILE` pin.
- [`src/users.js`](src/users.js) *(new, WIP)* — multi-user registry.
- [`src/scheduler.js`](src/scheduler.js) *(new, WIP)* — likely R12 poll scheduler.
- [`src/crypto.js`](src/crypto.js) *(new, WIP)* — likely R17 HMAC helpers.
- [`test/unit.test.js`](test/unit.test.js) — includes the "human low row still
  ships" regression test.
