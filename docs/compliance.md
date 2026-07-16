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
| 1 | Soniox EU region enabled on the account | **unknown** | Soniox docs state EU region is "enabled by request" per account/project (spec.md §4 item 1; plan §11). Not yet confirmed active on our account. **Verify**: log into `console.soniox.com` → select the project used by `SONIOX_WS_URL` → check the project/account region setting. Record the result (region name + screenshot or support-ticket reference) here when done. **2026-07-15 smoke diagnostic (Task 1.1)**: ran `scripts/soniox-check.mjs` against the EU endpoint (`wss://stt-rt.eu.soniox.com/transcribe-websocket`) with the current `.soniox-key` → `ERROR 401: Incorrect API key provided.` Re-ran the identical key against the global endpoint (`wss://stt-rt.soniox.com/transcribe-websocket`, temporary override, not committed) → succeeded with a live transcript. This confirms the key itself is valid and EU region is **not yet enabled** for this account/project — still `unknown`→pending human verification in Soniox Console, but now with a concrete failure signature to look for once EU is requested/enabled. |

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

## Cloud analysis LLM (Phase 6) gate

**GATE: no real-prospect cloud analysis until every row below is `done`; the
cloud-send feature flag stays OFF until then.** This mirrors the real-prospect
call gate above — the cloud analysis LLM is a second processor sitting on top
of the transcript/customer-brief data, and it needs its own DPA/retention/
consent chain before any real-prospect data may be sent to it. This section
implements the ledger rows required by `spec.md` §4 item 8 (cloud analysis
LLM as second data processor).

| # | Item | Status | Evidence / how to verify |
|---|------|--------|---------------------------|
| 1 | LLM vendor selection + DPA countersigned | **unknown** | No vendor DPA has been countersigned for cloud analysis use. **2026-07 research summary** (verification guidance, not a decision): Anthropic's direct API has no EU inference geo — EU residency currently requires going through a cloud reseller (AWS Bedrock `eu-central-1`/`eu-west-1`/`eu-west-3`/`eu-north-1`, or Google Vertex EU regions). OpenAI EU data residency is sales-gated, configured per-project, and only applies to newly created projects (existing projects cannot be migrated in place). Azure OpenAI requires an explicit EU Data Zone / regional deployment — the default "Global Standard" deployment tier is disqualifying for EU-only routing. Mistral is EU-hosted by default, but its Zero Data Retention (ZDR) terms are gated to the Scale plan. **Verify**: pick a vendor+deployment path from the above, confirm the specific region/deployment in that vendor's console, and countersign the DPA before recording `done`. |
| 2 | Retention / ZDR real terms | **unknown** | Do not assume "stateless on our side" implies zero retention on the vendor's side — **stateless on our side ≠ zero retention on theirs**. Vendors commonly run abuse-monitoring/safety windows (~30 days is a typical order of magnitude) even when the product-facing API is marketed as not persisting conversation state for training. **Verify**: read the specific vendor's data retention / abuse-monitoring policy (not just the ZDR marketing page) and record the actual retention window and its legal basis here. |
| 3 | Region-pinning evidence | **unknown** | Region selection must be confirmed **per project/account**, not assumed from a vendor's general EU availability. In particular, OpenAI project misconfiguration silently falls back to US routing — a project not explicitly configured for EU residency will process data in the US without any error. **Verify**: capture per-project console evidence (screenshot or API response showing the configured region) for the specific account/project actually used in production, not just "the vendor supports EU." |
| 4 | Subprocessor list review | **unknown** | The selected vendor's subprocessor list has not been reviewed. **Verify**: locate the vendor's published subprocessor list (typically in their trust/compliance center), confirm none of the subprocessors introduce an undocumented EU-residency or DPA gap, and record the review date + list version here. |
| 5 | Consent scope covers second processor + customer-brief data | **blocked(human)** | The existing per-call operator affirmation (Task 4.1, spec.md §4 item 2) was scoped to Soniox transcription only. Sending transcript and/or customer-brief content to a second processor (the cloud analysis LLM) is a materially different data flow and is **not** covered by that existing consent gate. Extending consent scope (or building a new gate) requires a human/legal decision — no agent may assume the existing affirmation covers this. |
| 6 | Customer-brief lawful basis (Art 6(1)(f)) | **blocked(human)** | Processing customer-brief data (see the customer-brief template below) needs a documented lawful basis. A one-paragraph legitimate-interest note under GDPR Art 6(1)(f) is the anticipated route, but that note must be human-authored and human-signed — no agent may draft or assume legal wording here, consistent with the `CONSENT_ANNOUNCEMENT_PL` policy above. |

### Recorded-as-fact: KB curation rule

| # | Item | Status | Evidence / how to verify |
|---|------|--------|---------------------------|
| 7 | KB curation rule: no emotional-state detection/exploitation content | **done** | Recorded as policy, consistent with spec.md §1 non-goals (no emotion/sentiment/stress/personality inference) and the Art 5(1)(f) workplace-monitoring tripwire under the EU AI Act. Psychology-adjacent notes in the knowledge base may describe **techniques and language** (what to say, how to phrase something) but must never contain instructions to **detect or exploit** a prospect's or rep's emotional state. No mood, rapport, or engagement **scores**, and no personality profiling of either the prospect or the rep, are permitted in KB content. This rule is enforced mechanically by a denylist lint applied at KB load time (Task 6.1). |

**Gate statement**: no real-prospect data (transcript or customer-brief
content) may be sent to the cloud analysis LLM until items 1–6 above are all
`done`; the cloud-send feature flag stays **OFF** until then. This mirrors the
"Real-prospect call gate" convention above — internal/test analysis with
synthetic or consenting-and-aware data is not blocked by this gate, but real
prospect or customer-brief data is.

## Maintenance

Update this file (not code comments, not Plans.md) whenever any of the
above items change status. Each status change must cite the evidence that
justifies it — a console screenshot reference, a signed-document
reference/date, or a linked human decision record. Do not flip `unknown`
to `done` based on inference; only a verified observation counts.
