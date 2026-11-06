# inlark project memory

Durable decisions and constraints that are easy to lose outside the code. The
requirements tracker at the top of `SPEC.md` remains the source of truth for
shipped status and priority.

## R12 laptop scheduling (2026-10-13)

- The company MacBook cannot be continuously docked and must remain safe to
  lock. Locking is compatible with the listener; physical sleep is not.
- Do not use admin sleep overrides or `caffeinate` to fight lid-close sleep.
- The beta promise is one weekday full digest per onboarded user at 08:00 local,
  caught up on first wake through 12:00. Nothing is promised while the Mac sleeps.
- The morning digest reuses the existing seven-day prioritised card. It is not
  R22's future one-day LOW/FYI TLDR.
- User-level launchd supervision provides login start and crash restart without
  admin access. It does not turn the laptop into an always-awake host.
- Scheduled guest reads must freshly resolve their isolated HOME and pass
  `assertIdentity`, exactly like an inbound `n`; cohort runs stay sequential.

## LiteLLM generic HTML 403 (2026-10-13)

- Both `/v1/chat/completions` and the read-only `/v1/models` probe returned the
  same generic nginx-style HTML `403 Forbidden` page. This differs from
  LiteLLM's JSON `key_model_access_denied` response for a disallowed model.
- Therefore this signature is a gateway/front-door rejection before the
  request reaches LiteLLM's key/model layer. Investigate network/VPN egress
  allow-listing or gateway policy; do not change the prompt or model name based
  on this HTML response alone.
- `npm run probe-models` is the fast discriminator: a successful model list
  means the gateway/key path works; the generic HTML 403 means access is still
  blocked upstream.
- Confirmed 2026-10-15: this gateway requires the company VPN. The generic HTML
  403 cleared once the VPN connected; check VPN connectivity first for this
  exact signature.

## Degraded morning recovery (2026-10-21)

- A delivered fallback is not a completed classified morning: retry every five
  minutes inside the existing morning window, suppress repeated fallback cards,
  and send one prioritized replacement after recovery. Healthy/empty sends are
  still deduplicated for the day. Persisted timestamps/date markers support restarts.
- The poll unread-set gate must allow reclassification when `lastDigest.cardMode`
  is `fallback`; unchanged messages do not imply classification succeeded.
- Auto-polls must still suppress delivery when that retry remains fallback and
  the unread-set signature is unchanged. Keep classifying on later slots so a
  recovered model can replace the degraded card; changed unread sets may update
  the fallback snapshot.
- Offline pipeline tests inject fetch/classification/delivery/state boundaries;
  use `DOTENV_CONFIG_PATH=/dev/null npm test` to avoid loading protected `.env`.
- Owner morning logs also showed lark-cli exiting with `token already refreshed
  by another process` during parallel reads. Retry that exact pre-API stderr
  signature once after 200ms under the same HOME/profile; never broaden this to
  API/send failures or revoked-token errors. Tests use a fake CLI in an empty
  temporary HOME and never load real credentials.
- Follow-up at 16:14 SGT: the new `[digest]` log proved the listener loaded the
  fix, but the owner still got 0/29 classifications because both LiteLLM chunks
  failed with `ECONNRESET`, not HTML 403. Do not call the incident resolved based
  on offline retry tests: owner-run gateway probe and a live prioritized card
  remain necessary. Model requests now retry transient transport failures at
  most twice (500ms/1500ms), with 60s per-attempt deadlines; persistent VPN/gateway
  failure cannot be repaired by rescheduling or retries alone.
