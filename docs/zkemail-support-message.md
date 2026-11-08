# Message for zkEmail support (Telegram / Discord)

Paste this. It leads with the one fact they need and gives the diagnostics without
making them ask. Keep the uuid in: the slug path 404s on their own site, so the uuid is
how they will find it.

---

Hi — a blueprint compile looks stuck rather than slow and I would like to know whether
it failed silently before I queue another.

**Blueprint:** `DE-LIGHTPRO/moniepointdebitalert` v1
**URL:** https://registry.zk.email/811e63d3-5430-42e8-aa0f… (uuid truncated, happy to DM in full)
**Status:** In Progress, "Updated 1 day ago" as of 8 Nov 11:41 UTC+1 — about 25 hours
**The page says:** "The blueprint compilation is in progress and will take few hours to complete"

**Configuration**

- Sender domain `moniepoint.com`, selector `s1` (a CNAME into SendGrid, if that matters)
- Four extracted fields: `email_sender` (max 64), `amount` (16), `nullifier` (64),
  `recipient` (8)
- `remove_soft_linebreaks: true`
- Max body length 7680, with a body cutoff value anchored on the HTML amount span

**What I already tried**

Four earlier attempts at creating this blueprint returned 500s. I traced that to circuit
size and fixed it by adding the body cutoff and capping max body length at 7680, after
which it created successfully and entered compilation. So size has been the failure mode
here before, which is why I suspect it again.

**What I would like to know**

1. Is this job still running, or has it failed without the status changing?
2. If it is too large, does tightening `email_sender` 64→24 and `nullifier` 64→60 sound
   likely to get it through? Those are the real sizes — the sender is 23 characters and
   the MIME boundary is always exactly 60 — so I am not truncating anything.
3. Is there a way to see compiler output or a failure reason for a job in this state?

Context: this is for a hackathon submission due 9 Nov 22:00 UTC, so I am deciding today
whether to wait on this one or queue a smaller v2. Any steer is appreciated — happy to
be told to just wait.

---

## If they do not reply in a couple of hours

Queue v2 anyway. It costs nothing, v1 keeps running, and waiting for an answer is the
one thing that cannot be recovered. See `docs/blueprint-spec.md` section 8.
