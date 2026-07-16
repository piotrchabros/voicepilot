# Real-Time Sales Assistant — Product Spec (SSOT)

Status: v1 draft, 2026-07-15. Precedence: this file > sub-specs > Plans.md.
Input: `realtime-sales-assistant-plan.md` (proposal), reconciled against the
live-verified Electron pipeline by a 3-perspective review (Architecture/Product,
Security/Compliance, QA/Skeptic). Where this spec deviates from the proposal,
this spec wins — deviations are listed in §8.

## 1. Product

A real-time assistant for a single sales operator (Poland/EU). It listens to a
live call, transcribes per speaker, detects objections/signals in the
**prospect's** speech, and shows a suggested play (card: headline ≤6 words + one
line, detail on tap) — visible before or within ~1s of the prospect finishing.

Two transports, one pipeline:
- **Transport B — system audio (Electron)**: exists and is live-verified
  (Swift sidecar → VAD → Soniox → hint engine → content-protected overlay).
- **Transport A — Twilio PSTN**: new; operator-initiated outbound bridge with
  media forking. Built only after the transport-agnostic core is hardened.

Non-goals (v1): mobile, inbound PSTN, multi-tenant, meeting bots, call-recording
storage (in-memory transcripts; persistence off by default), and **any emotion /
sentiment / stress / personality inference** (EU AI Act) — classifiers label
*what was said*, never *how they feel*; the generation prompt must carry the
same prohibition.

## 2. The seam: `AudioSource`

All transports implement one interface; `CallSession` (the pipeline) knows
nothing about transports.

- `AudioFrame = { speaker: 'prospect'|'rep', pcm: Float32Array /*16kHz mono*/,
  t: number /*ms since capture start, monotonic per speaker, source-provided*/ }`
- `AudioSource = { transport, speakers, separation: 'clean'|'mixed',
  start(), stop(), on('audio'|'end'|'health') }`
- **Deviation from proposal:** internal frame format stays **Float32 @16kHz**
  (the existing sidecar/VAD/STT contract); conversion to `pcm_s16le` happens
  once, inside the Soniox client, as today. PCM16 at the seam bought nothing.
- `separation` is honest metadata: Twilio legs are `clean`; system loopback is
  `mixed` (everyone-but-the-rep). Mixed input raises the Tier-1 confidence
  threshold (diarization deferred; decision recorded, not silent).
- `FileAudioSource` (wav replay via the existing `wav.ts`/bench harness) is the
  test double every downstream test uses.

## 3. Pipeline behavior (the core idea is kept)

- **Turn detection is owned by the local Silero VAD** (ENTER 0.5/EXIT 0.35,
  HANGOVER_MS=250). Soniox endpoint detection stays off. There is exactly one
  turn detector. (Proposal's finals+600ms debounce: rejected as a regression.)
- **Speculative suggestion is kept**: retrieval paints instantly on interims;
  generation streams and overwrites; cancel-previous is the design. Tier-1
  classification runs on **settled prospect turns** as a *gate + telemetry
  label*, not as the trigger for showing something.
- Tier-1 labels: `price_objection | timing_objection | authority_objection |
  need_question | competitor_mention | buying_signal | smalltalk | none`.
  Polish-first rules with fixture tests; `smalltalk|none` suppresses cards.
- Playbook: YAML entries `{ id, trigger, headline, line, detail }`, loaded at
  boot; matching stays **char-trigram cosine** (Polish-inflection-robust,
  ~10ms). No vector store at 10–15 plays. Content is the moat.
- Transcript store: append-only, grow-to-cap-then-reset (prefix-cache-safe for
  the local LLM). Rolling-window rendering may be used **only** for stateless
  cloud generation calls.
- Latency: per-stage timestamps tagged with `transport` on every suggestion.
  Budget: card on screen < 1.3s (B) / < 1.5s (A) after prospect stops —
  speculation should beat this in the common case.

## 4. Compliance & security (EU) — blocking requirements

1. **Soniox EU**: endpoint comes from config (`SONIOX_WS_URL`); boot asserts the
   resolved hostname against the documented EU host allowlist and refuses to
   start otherwise. The account/project must be EU-region (enabled by request —
   verify). Applies to the existing Electron path too (today it hardcodes the
   global endpoint — must be fixed before further real-prospect use).
2. **Consent, per transport**: A = `<Say>` announcement on the prospect leg
   pre-bridge (`CONSENT_ANNOUNCEMENT_PL`, wording is a legal deliverable, never
   invented by an agent). B = procedural: per-call operator affirmation gate
   (logged with timestamp), persistent recording indicator, announcement script
   on screen. B carries more legal risk than A; this is a recorded human
   decision, not papered over.
3. **DPAs countersigned (Soniox + Twilio) before any real-prospect call.**
4. **Log hygiene**: no transcript/hint text in logs outside explicit debug mode;
   production default logs contain no call content.
5. **Twilio**: region `ie1`/edge `dublin`; webhook signature validation on every
   `/voice/*` route (against the public URL); media WS requires a signed,
   TTL'd, callSid-bound token passed via `<Parameter>` — close on missing/bad
   token. `POST /call` requires auth (never an open dialer through the tunnel).
6. **Local surfaces**: Transport-B WS and operator UI bind to 127.0.0.1 and
   carry a session token. Secrets via `.env` + zod fail-fast; `.soniox-key`
   file fallback is deprecated.
7. ngrok/cloudflared is a dev-only third-party processor; documented as such.
8. **Cloud analysis LLM (Phase 6) is a second data processor.** Endpoint from
   config (`LLM_API_URL` + explicit region/deployment-class fields); boot
   asserts the resolved endpoint against a documented EU allowlist and refuses
   to start otherwise — the allowlist must encode deployment class, not just
   hostname (Azure "Global Standard" / Vertex "global" routes are
   disqualifying even on EU-looking hosts). HTTPS only. DPA, retention/ZDR
   terms ("stateless on our side" ≠ zero retention on theirs — abuse-monitoring
   windows are the real retention), per-project region-pinning evidence, and
   subprocessor review are ledger rows in `docs/compliance.md`; cloud sends sit
   behind a feature flag (default **off**) until those rows are green. Consent
   scope for the second processor + customer-brief data is a legal
   deliverable; the per-call affirmation record lists the processor set it
   covered (`soniox` vs `soniox+llm`).

## 5. Operator UI

One card visible; new suggestion replaces. Headline ≤6 words. Live transcript
secondary and ignorable. Visual cues only. Transport chrome: mode selector,
health banners (sidecar/device/Soniox/media-WS), and Transport-B consent gate +
recording indicator. The existing content-protected overlay remains the
Transport-B surface; a browser operator page is added only when Transport A
ships (they share the suggestion payload).

Phase 6 adds a second, separately content-protected **analysis panel** window.
It is hidden by default and shown by explicit operator toggle; refresh happens
on toggle / manual "refresh now" (debounced auto-refresh is a recorded later
option, not v1). Fixed skeleton, stable section ordering, deltas highlighted:
one-line call-stage indicator + up to three suggested next questions, stamped
"as of turn N" and greyed when stale, plus a visible cloud-processing
indicator (analogous to REC). Objection responses stay exclusively on the hint
card — the panel is non-directive context, never a competing "say this now"
surface. The tiny hint card stays byte-for-byte untouched, and the panel's
generation path must never delay it.

## 6. Process topology

Now: everything stays in the Electron app (sidecar → main → utilityProcess).
When Transport A starts: lift `src/pipeline` into a standalone Node service
(Fastify; serves TwiML webhooks, media WS, Electron WS, UI WS) and the Electron
app becomes a thin capture-forwarder client. Not before.

## 7. Knowledge base & analysis engine (Phase 6)

- **KB = local files.** `knowledge/**/*.md` (sales closing practices, strategy,
  sales-psychology notes, product/service info), chunked by `##` heading;
  retrieval is char-trigram cosine per section, top-K (same Polish-inflection
  rationale as §3; embeddings stay rejected at ≤~200 sections — revisit only
  with recall evidence, as its own recorded decision). `customers/<name>.md`
  briefs are operator-selected at call start via a dropdown on the pre-Start
  consent screen (default: none) and always injected — never retrieved, never
  committed to git, never copied into derived stores (no untracked
  personal-data copies; deletion = delete the file).
- **KB content rule (EU AI Act):** psychology notes may describe techniques
  and language, never instructions to detect or exploit the prospect's
  emotional state; a denylist lint on KB files enforces this at load. No
  rapport/mood/engagement scores, no personality profiling — of prospect *or*
  rep (Art 5(1)(f): rep-side emotion inference is the workplace tripwire; any
  rep-side analysis stays behavioral, e.g. talk-time, never emotional).
- **`AnalysisEngine` is a sibling of `HintEngine`** in `src/pipeline`
  (transport-agnostic; rides the Phase-5 service lift unchanged). Trigger:
  settled prospect turn-end only, debounced ~1.5s (separate from the hint
  debounce); cancel-previous, never queue. Prompt is rendered via a new
  `TranscriptState.renderRollingWindow()` — the cache-locked `renderPrompt()`
  is not touched or shared. Only the rolling window + top-K KB snippets + the
  selected brief leave the device, never the whole KB.
- **Closed output schema (zod):** `{ stage, suggested_questions (≤3),
  next_steps? }` — no free-form prospect-state field. The §1 no-emotion
  prohibition is carried in the analysis prompt AND enforced on the output
  path: non-conforming or sentiment-bearing responses are dropped, not
  rendered. Prompts frame output as legitimate persuasion/objection handling;
  deceptive claims, false urgency, and vulnerability-exploiting tactics are
  prohibited wording.
- **Latency/cost:** asynchronous best-effort surface — never shares or delays
  the card budget (§3). Bench reports analysis p50/p95 and tokens/call
  separately from `BenchStage`; card p95 must be unchanged vs baseline. A
  hard per-call token cap applies.
- **Log hygiene (§4.4) extends** to analysis prompts, retrieved KB snippets,
  brief content, analysis output, and HTTP-client error bodies (a failed LLM
  call must not dump its request payload into logs).
- **Recorded v1 exclusions** (deviations from the original feature ask):
  objection-break responses in the panel (duplicate of the hint card —
  contradiction risk), continuous per-turn refresh (untrackable motion,
  staleness churn), post-call summary and stage-gated next-steps expansion
  (good later options, not v1).

## 8. Recorded deviations from `realtime-sales-assistant-plan.md`

- Seam frame format Float32 (not PCM16); envelope adapts to existing IPC, no
  new WS bridge inside Electron for v1.
- One turn detector (VAD, 250ms) — proposal's 600ms finals-debounce rejected.
- Speculative generation kept; "only finals feed the classifier" applies to the
  Tier-1 *gate*, not to suggestion rendering.
- Lazy, VAD-gated Soniox sessions kept (billing: stream duration is charged);
  proposal's always-on per-speaker sessions rejected.
- Trigram retrieval kept; sqlite-vec/embeddings rejected at this scale.
- Fastify service deferred to the Twilio phase.
