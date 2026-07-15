# Compliance & legal blocker ledger

Source of truth for the EU compliance/legal blockers called out in
`spec.md` §4 ("Compliance & security (EU) — blocking requirements") and
`realtime-sales-assistant-plan.md` §11 ("Open questions for the human").

This ledger tracks status only. It does not invent legal wording, does not
assert facts nobody has verified, and does not treat "nobody checked yet" as
"the answer is no." Use the following status vocabulary consistently:

- **done** — verified and evidenced (link, screenshot, or explicit
  confirmation from an authoritative source).
- **unknown** — **not yet verified**. This is *not* the same as "false" or
  "absent." It means: someone with account/console access needs to look and
  record the result here. Do not read `unknown` as "the feature is off" or
  "the DPA is missing" — it means the state is not observed yet.
- **blocked(human)** — requires a human decision or a human-authored
  deliverable (legal wording, HR/labor-law sign-off) that an agent must not
  and cannot produce on its own.

**Convention:** `not_observed != absent`. An `unknown` row is an open TODO
for a human with the right access, not evidence of a gap.

## Real-prospect call gate (spec.md §4 item 3, plan §11)

**BLOCKING: no real-prospect call may be placed until items 1–5 below are
all `done`.** Internal/test calls with consenting participants who are
aware they are part of a system test are not "real-prospect calls" for the
purpose of this gate, but still require the Transport-B procedural consent
gate in §5.5 of the plan to be observed. `spec.md` §4 items 1 and 3
(Soniox EU region + DPAs countersigned "before any real-prospect call") are
the direct source of this gate; items 4/5 below are corollary legal
blockers that must clear for the same reason (consent + labor-law
compliance are prerequisites to *any* recording of a real prospect or
employee).

| # | Item | Status | Evidence / how to verify |
|---|------|--------|---------------------------|
| 1 | Soniox EU region enabled on the account | **unknown** | Soniox docs state EU region is "enabled by request" per account/project (spec.md §4 item 1; plan §11). Not yet confirmed active on our account. **Verify**: log into `console.soniox.com` → select the project used by `SONIOX_WS_URL` → check the project/account region setting. Record the result (region name + screenshot or support-ticket reference) here when done. |
| 2 | Soniox DPA signed + audio retention / zero-data-retention (ZDR) terms confirmed | **unknown** | plan §11: "DPA: countersign in Soniox Console → Security & compliance." Not yet countersigned or reviewed as of this writing. **Verify**: Soniox Console → Security & compliance → Data Processing Agreement; confirm whether ZDR is available/enabled and what audio retention window applies absent ZDR. Record countersignature date + retention terms here. |
| 3 | Twilio DPA + EU data residency addendum | **unknown** | plan §11: "Same for Twilio." Not yet countersigned or reviewed. **Verify**: Twilio Console → Legal/Compliance → Data Protection Addendum; confirm EU data residency addendum is in effect (relevant given spec.md §4 item 5: region `ie1`/edge `dublin`). Record countersignature date + addendum scope here. |
| 4 | `CONSENT_ANNOUNCEMENT_PL` legal review | **blocked(human)** | spec.md §4 item 2: wording "is a legal deliverable, never invented by an agent." plan §11: "Legal review of the consent announcement wording + two-party consent under Polish law." No agent (including this one) may draft or approve the announcement text. **Placeholder policy**: until legal sign-off lands, any `CONSENT_ANNOUNCEMENT_PL` value in code/config must be a clearly-marked placeholder (e.g. `"[PLACEHOLDER — NOT LEGALLY REVIEWED — DO NOT USE ON REAL CALLS]"`) and any code path that plays it must refuse to proceed with a real (non-test) call. Replace only with text supplied by human legal counsel, verbatim. |
| 5 | Rep-side employee monitoring notice (Polish labor law) | **blocked(human)** | Transport B records/monitors the operator's (rep's) own audio and screen. Polish labor law imposes notice/consent obligations on employee monitoring that are independent of prospect consent (spec.md §4 item 2 asymmetry note; plan §5.5 "Consent — the asymmetry that matters"; plan §11 two-party consent question). Requires HR/legal sign-off on the notice mechanism and its timing before any rep is recorded against a real prospect. No agent may draft or assume this notice exists. |

## Recorded-as-fact items

| # | Item | Status | Evidence / how to verify |
|---|------|--------|---------------------------|
| 6 | ngrok/cloudflared is a dev-only third-party processor | **done** | Recorded as policy per spec.md §4 item 7: "ngrok/cloudflared is a dev-only third-party processor; documented as such." This tunnel path must not be used to expose `/voice/*` or media-WS routes for real-prospect production traffic — it exists for local development only, and any audio/webhook payload transiting it passes through a third-party processor with no DPA coverage from this ledger. |

## Other open items tracked in plan §11 (non-blocking for the gate above, but unresolved)

| Item | Status | Notes |
|------|--------|-------|
| Transport B consent gap (§5.5) — accept procedural control, or restrict B to internal/consented calls only | **unknown** — human decision pending | plan §11: "This is a decision, not a task." Not an agent call. |
| Polish WER on 8kHz (A) vs 16kHz (B) usability bar | **unknown** | Requires real measurement; not a compliance blocker per se but affects whether Transport A is viable at all. |
| Mixed-channel handling in Transport B (§6.3) | **unknown** | Threshold vs diarization decision pending. |
| Retention policy if `PERSIST_TRANSCRIPTS=true` ever ships | **unknown** | No retention policy has been written; if this flag is ever turned on, item 2 above (Soniox retention/ZDR) and a written retention policy must both be in place first. |

## Maintenance

Update this file (not code comments, not Plans.md) whenever any of the
above items change status. Each status change must cite the evidence that
justifies it — a console screenshot reference, a signed-document
reference/date, or a linked human decision record. Do not flip `unknown`
to `done` based on inference; only a verified observation counts.
