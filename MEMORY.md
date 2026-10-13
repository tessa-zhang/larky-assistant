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
