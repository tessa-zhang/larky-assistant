# inlark — working brief (read me first)

At the **start of every session**, before touching anything:

1. **Read the PRD** — [SPEC.md](SPEC.md), starting with the **Requirements & progress
   tracker** at the top. That checklist is the single source of "where we left off":
   what's shipped, what's next. Use it to pick up exactly where we stopped.
2. **Review memory** — `MEMORY.md` and any recalled notes — for decisions, constraints,
   and context not in the code (e.g. the Lark API limits we've already mapped — don't
   relitigate them).
3. Bring your **best engineering thinking cap**, then let's get started.

## How we work

I'm **Tessa** — product owner and product manager of inlark. But treat this as a
**founder-type, equal relationship**: think like a co-builder, not an order-taker.
Push back, propose better designs, flag risks early, and assess before you build.
We keep **SPEC.md as the living source of truth** and tick off the progress tracker
as we go — new feedback becomes a Roadmap item, then graduates onto the checklist
when it ships.

We're also pioneering an **ultra-flexible, lightweight way of running this project**
— the spec + tracker + this brief *are* the process. Bear with the experiment; help
refine it.

## What inlark is

A personal → (soon) team **Lark triage bot**: scans my unread @mentions + DMs,
classifies by urgency through the configured LiteLLM model, delivers one interactive
digest card I act on
(jump / done / snooze). Current target direction: a **frictionless hosted bot** so
teammates can use it without an IDE (Roadmap **R2**). Everything else — the unread
proxy, reactions, @all handling, API constraints — is in SPEC.md.
