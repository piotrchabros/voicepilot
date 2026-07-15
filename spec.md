# Real-Time Sales Assistant — Product Spec (SSOT)

Status: v1 draft, 2026-07-15. Precedence: this file > sub-specs > Plans.md.
Input: `realtime-sales-assistant-plan.md` (proposal), reconciled against the
live-verified Electron pipeline by a 3-perspective review (Architecture/Product,
Security/Compliance, QA/Skeptic). Where this spec deviates from the proposal,
this spec wins — deviations are listed in §7.

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
  t: number /*ms, monotonic, source-provided*/ }`
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

## 5. Operator UI

One card visible; new suggestion replaces. Headline ≤6 words. Live transcript
secondary and ignorable. Visual cues only. Transport chrome: mode selector,
health banners (sidecar/device/Soniox/media-WS), and Transport-B consent gate +
recording indicator. The existing content-protected overlay remains the
Transport-B surface; a browser operator page is added only when Transport A
ships (they share the suggestion payload).

## 6. Process topology

Now: everything stays in the Electron app (sidecar → main → utilityProcess).
When Transport A starts: lift `src/pipeline` into a standalone Node service
(Fastify; serves TwiML webhooks, media WS, Electron WS, UI WS) and the Electron
app becomes a thin capture-forwarder client. Not before.

## 7. Recorded deviations from `realtime-sales-assistant-plan.md`

- Seam frame format Float32 (not PCM16); envelope adapts to existing IPC, no
  new WS bridge inside Electron for v1.
- One turn detector (VAD, 250ms) — proposal's 600ms finals-debounce rejected.
- Speculative generation kept; "only finals feed the classifier" applies to the
  Tier-1 *gate*, not to suggestion rendering.
- Lazy, VAD-gated Soniox sessions kept (billing: stream duration is charged);
  proposal's always-on per-speaker sessions rejected.
- Trigram retrieval kept; sqlite-vec/embeddings rejected at this scale.
- Fastify service deferred to the Twilio phase.
