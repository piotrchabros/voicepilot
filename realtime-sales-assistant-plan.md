# Real-Time Sales Assistant — Implementation Plan

**Audience:** coding agent
**Goal:** a Node.js service that ingests live call audio from **either** a PSTN bridge (Twilio) **or** system audio capture (Electron), transcribes per-speaker via Soniox, detects objections/signals in the prospect's speech, and pushes suggested plays to the operator UI within ~1.5s of the prospect finishing a sentence.

**Two transports, one pipeline.** Everything below the `AudioSource` boundary is transport-agnostic. Adding a third transport later (Recall.ai for meeting bots) is a new adapter, not a rewrite.

---

## 0. Scope & non-goals

**In scope (v1)**
- **Transport A — Twilio (PSTN):** operator clicks "call", Twilio dials the operator, then the prospect, bridges them, forks both legs to a Node WebSocket.
- **Transport B — System audio (Electron):** operator is on any call (Zoom/Meet/Teams/phone-through-headset); Electron captures mic + system loopback and streams both to the same Node pipeline. **Already built — see §5.**
- Per-speaker Soniox streaming sessions.
- Rolling transcript → trigger classification → playbook retrieval → suggestion push.
- Single-operator, localhost UI.

**Explicit non-goals (v1)**
- No mobile app. No inbound PSTN handling. No multi-tenant. No meeting-bot transport. No call recording storage (transcripts in memory; persistence behind an off-by-default flag). No emotion/sentiment inference (EU AI Act exposure — classify topic/objection type only).

**Hard constraints**
- Operator is in Poland/EU. Consent notice before the prospect is recorded — non-negotiable, and it works **differently per transport** (§4.3, §5.5). This is the main asymmetry between A and B.
- Soniox project MUST be created in the **EU region**; calls MUST hit the EU endpoint. Assert at boot.
- Twilio: EU region (`ie1`, edge `dublin`).

---

## 1. Architecture

```
┌─ Transport A ──────────────┐   ┌─ Transport B ─────────────┐
│ Twilio Voice               │   │ Electron renderer         │
│  <Start><Stream>           │   │  mic + system loopback    │
│  both_tracks → wss://media │   │  → local WS / IPC         │
└────────────┬───────────────┘   └────────────┬──────────────┘
             │                                │
        TwilioAudioSource            SystemAudioSource
             └──────────────┬─────────────────┘
                            ▼
                  ┌──────────────────┐
                  │   AudioSource    │   ← the seam (§2)
                  │  emits: frame{   │
                  │    speaker,      │
                  │    pcm16_16k,    │
                  │    t }           │
                  └────────┬─────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │  CallSession (transport-agnostic)        │
        │   ├── SonioxSession × N (one per speaker)│
        │   ├── TranscriptStore (rolling window)   │
        │   ├── TurnDetector                       │
        │   ├── TriggerClassifier (prospect only)  │
        │   ├── PlaybookRetriever                  │
        │   └── SuggestionEngine                   │
        └──────────────────┬───────────────────────┘
                           ▼
                    Operator UI (WS)
```

**Key decision:** normalize to a single internal audio format at the seam — **PCM16, 16kHz, mono, per-speaker**. Both adapters convert *up* to this. Nothing downstream knows or cares where audio came from.

Why 16kHz and not 8kHz: Transport B genuinely has wideband audio and it would be self-harm to throw it away just to match the telephony path. Transport A upsamples from 8kHz — this adds no information, but it means one Soniox config, one classifier, one set of thresholds. Accept the small waste.

---

## 2. The seam: `AudioSource`

Write this first. Both transports implement it. This is the single most important structural decision in the doc.

```ts
type SpeakerRole = 'prospect' | 'rep';

type AudioFrame = {
  speaker: SpeakerRole;
  pcm: Buffer;        // PCM16LE, 16kHz, mono
  t: number;          // ms since call start, monotonic, source-provided
};

interface AudioSource {
  readonly transport: 'twilio' | 'system';
  readonly speakers: SpeakerRole[];        // which roles this source can emit
  readonly separation: 'clean' | 'mixed';  // see §6 — drives classifier confidence
  start(): Promise<void>;
  stop(): Promise<void>;
  on(e: 'audio', h: (f: AudioFrame) => void): void;
  on(e: 'end',    h: (reason: string) => void): void;
  on(e: 'health', h: (s: { ok: boolean; detail: string }) => void): void;
}
```

`separation` is not decoration. Transport A gives genuinely clean per-leg audio. Transport B's "prospect" channel is *everyone who isn't the rep*, mixed. Downstream must be able to know the difference (§6.3).

`CallSession` accepts an `AudioSource` and knows nothing else about transports.

```ts
const source = mode === 'pstn'
  ? new TwilioAudioSource({ prospectNumber })
  : new SystemAudioSource();

const session = new CallSession(source, { language: 'pl' });
await session.start();
```

---

## 3. Stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node 20+, TypeScript, ESM | |
| HTTP/WS | Fastify + `@fastify/websocket` | serves TwiML webhooks, media WS, Electron WS, UI WS |
| Desktop | Electron (existing) | see §5 |
| Telephony | `twilio` SDK | region `ie1`, edge `dublin` |
| STT | Soniox WebSocket streaming, **EU endpoint** | one session per speaker |
| Resampling | `@alexanderolsen/libsamplerate-js` or hand-rolled | see §4.4 / §5.3 — do **not** spawn ffmpeg per call |
| Tunnel (dev) | `ngrok` / `cloudflared` | Transport A only; Twilio needs public HTTPS + WSS |
| Vector store | `sqlite-vec` or in-memory | playbook is small; don't over-engineer |
| UI | plain HTML + htmx, or Vite/React | one screen; don't build a SPA if htmx does it |
| Config | `zod` + `.env` | fail fast on missing keys |

**Process topology:** the Node pipeline runs as a service. In Transport B it can run *inside* the Electron main process or as a sidecar the renderer talks to over localhost WS. Prefer **sidecar** — it keeps one codebase serving both transports and keeps the pipeline testable without booting Electron.

---

## 4. Transport A — Twilio (PSTN)

### 4.1 Initiate
`POST /call { prospectNumber }` →

```ts
client.calls.create({
  to: OPERATOR_NUMBER,          // rings the rep first
  from: TWILIO_NUMBER,
  url: `${PUBLIC_URL}/voice/bridge?prospect=${encodeURIComponent(prospectNumber)}`,
});
```

### 4.2 `/voice/bridge` TwiML

```xml
<Response>
  <Start>
    <Stream url="wss://PUBLIC_HOST/media" track="both_tracks">
      <Parameter name="token" value="{{signedToken}}"/>
    </Stream>
  </Start>
  <Dial answerOnBridge="true" callerId="{{TWILIO_NUMBER}}">
    <Number url="/voice/consent">{{prospect}}</Number>
  </Dial>
</Response>
```

- `<Start><Stream>` is **non-blocking** — the fork runs alongside the call. (`<Connect><Stream>` would hijack it; wrong tool.)
- `track="both_tracks"` gives two labelled tracks on one WS.
- `<Number url="...">` runs TwiML on the prospect leg **when they answer, before bridging** — that's the consent hook.

### 4.3 `/voice/consent` (prospect leg, pre-bridge)

```xml
<Response>
  <Say language="pl-PL" voice="Polly.Ewa">{{CONSENT_ANNOUNCEMENT_PL}}</Say>
</Response>
```

> **AGENT NOTE:** exact wording is a legal question, not an engineering one. Config value, `// TODO: legal review`. Do not invent legal text and ship it silently.

### 4.4 `TwilioAudioSource` — the `/media` WebSocket

Twilio JSON frames:

| event | action |
|---|---|
| `connected` | ignore |
| `start` | verify signed token from `customParameters`. Read `callSid`, `tracks`. Bind to call context. |
| `media` | `media.track` ∈ `{inbound, outbound}`, `media.payload` = base64 **μ-law 8kHz mono**, 20ms frames |
| `mark` | ignore (v1) |
| `stop` | emit `end` |

Per frame: base64 → μ-law → PCM16 8kHz → upsample to 16kHz → emit `AudioFrame`.

```ts
const ulaw = Buffer.from(msg.media.payload, 'base64');
const pcm8 = ulawToPcm16(ulaw);            // 256-entry LUT, no ffmpeg
const pcm16 = upsample8to16(pcm8);
emit('audio', { speaker: TRACK_MAP[msg.media.track], pcm: pcm16, t: msg.media.timestamp });
```

**Gotchas:**
- ~50 frames/sec **per track** (~100/sec total). Zero blocking work in this handler.
- `inbound` = audio from the PSTN into Twilio = **the prospect**. `outbound` = what Twilio plays to the caller = **the rep**. Defined from Twilio's perspective, not the rep's. **Verify empirically on the first test call** (§9 step 4) — getting it backwards silently produces a coach that analyses your own rep.
- Use `media.timestamp` (ms since stream start), never `Date.now()`. Tracks don't start simultaneously.
- Twilio will **not** re-establish a dropped media WS. Call continues, transcription doesn't. Emit `health: {ok:false}` → UI banner.
- `separation: 'clean'`, `speakers: ['prospect','rep']`.

### 4.5 Teardown
Status callback `/voice/status` → on `completed`, emit `end`. Also handle the media `stop` event. Whichever fires first wins — **teardown must be idempotent**.

---

## 5. Transport B — System audio (Electron) — **already built**

> **AGENT NOTE:** the capture layer exists. This section specifies how it plugs into the seam, **not** how to build capture. Before changing anything here, read the existing Electron code and reconcile — the fields below are the contract the pipeline needs, and the existing implementation may already satisfy them under different names. Adapt the adapter, not the pipeline.

### 5.1 Channel mapping

| Physical channel | Role | Reality |
|---|---|---|
| Microphone | `rep` | clean, single speaker |
| System loopback | `prospect` | **everyone except the rep, mixed** |

On a 1:1 call this is effectively clean. On a 4-person Zoom it is not. `separation: 'mixed'` — always, because the source can't know how many people are on the far end.

### 5.2 `SystemAudioElectron` → Node contract

Renderer/main captures → sends to the pipeline over localhost WS (`/audio/system`) or IPC. Frame envelope:

```ts
{ ch: 'mic' | 'loopback', seq: number, t: number, pcm: <binary PCM16LE 16k mono> }
```

Send **binary** frames, not base64 JSON — this is a local socket, don't pay the 33% tax and the parse cost 100×/sec.

### 5.3 `SystemAudioSource` (the adapter)

- Map `mic → rep`, `loopback → prospect`.
- If capture is at 48kHz (likely — most system capture is), **downsample to 16kHz in Electron**, not in the pipeline. Keeps the wire cheap and the pipeline uniform.
- `t` must be a monotonic ms counter from capture start, shared across both channels, derived from **sample count**, not wall clock. Mic and loopback are separate device clocks and *will* drift. Sample-count timestamps make the drift visible instead of silently reordering turns.
- Emit `health` on device loss (headset unplugged, virtual device removed) — a common, silent failure.

### 5.4 Echo

The rep's voice is in the loopback channel only if the rep is on speakers. **Require a headset.** Document it as a hard requirement, detect it if you can, and warn in the UI if the mic and loopback correlate above a threshold — that means speakers, which means the rep's own words are being classified as the prospect's. Cheap check, saves a genuinely confusing class of bug.

### 5.5 Consent — the asymmetry that matters

Transport A can force an announcement onto the prospect's leg before bridging. **Transport B cannot.** There is no channel to inject audio into someone else's Zoom call, and no technical fix for this.

So in Transport B, consent is a **procedural** control, not a technical one:
- Block the Start button behind an explicit "I have obtained consent / I will announce it" affirmation, per call. Logged with timestamp.
- Show a persistent, unmissable recording indicator in the UI for the whole call.
- Surface the announcement script (same config string as `CONSENT_ANNOUNCEMENT_PL`) on screen so the rep can read it aloud.

> **AGENT NOTE:** don't quietly treat B as equivalent to A. This gap is the reason Transport B carries more legal risk than Transport A, and the human needs to decide whether that's acceptable. Flag it, don't paper over it.

---

## 6. Pipeline (transport-agnostic — everything below the seam)

### 6.1 Soniox sessions

**Read the docs before writing this code** — streaming config schema and audio format identifiers must come from the live API reference, not memory:
- https://soniox.com/docs/ (streaming API + audio formats)
- https://soniox.com/docs/data-residency (EU endpoint)
- https://soniox.com/docs/security-and-privacy

```ts
class SonioxSession {
  constructor(opts: { speaker: SpeakerRole; language: 'pl'; onPartial; onFinal });
  send(pcm16_16k: Buffer): void;   // coalesce ~100ms before sending
  close(): Promise<void>;
}
```

- **Assert at boot** that the configured endpoint is the EU one. Refuse to start otherwise.
- Coalesce frames into ~100ms chunks. Fewer, larger writes.
- **Partials drive the UI transcript. Only finals feed the classifier.** Classifying partials produces flickering suggestions.
- Reconnect with backoff mid-call; buffer ≤2s during reconnect, then drop. Never grow unbounded.
- One session per speaker, spun up lazily on first frame for that role.

### 6.2 TranscriptStore + TurnDetector

- Append-only per speaker: `{ speaker, text, tStart, tEnd }`.
- Rolling window: last ~15 turns for classifier/retrieval context. Never the whole call.
- Turn-end = final segment from prospect + `TURN_END_DEBOUNCE_MS` (~600ms) of no new prospect audio. **Single biggest lever on perceived latency** — tunable constant, not a magic number.
- In-memory by default. Persistence behind a flag, off by default (GDPR: don't store what you don't need).

### 6.3 TriggerClassifier

Runs **only on completed prospect turns**. Two tiers.

**Tier 1 — cheap gate.** Label set:
`price_objection | timing_objection | authority_objection | need_question | competitor_mention | buying_signal | smalltalk | none`

Keyword/regex rules for Polish + a small fast model. Target < 200ms. `smalltalk|none` → emit nothing.

**Tier 2 — retrieval + adaptation.** Only when tier 1 fires:
1. Embed the turn, retrieve top-3 plays (§6.4).
2. Small generation call: adapt the play to actual wording, given the last ~15 turns. Hard output cap.

**Do not generate plays from scratch.** Retrieval is what makes this fast, consistent, defensible.

**Transport-awareness:** when `source.separation === 'mixed'`, the prospect channel may contain multiple speakers. Either (a) raise the tier-1 confidence threshold, or (b) run diarization on that channel. Do **not** silently treat mixed input as clean — quality will drop and you'll blame the classifier when the fault is upstream. Pick one, write it down.

**Explicitly forbidden:** emotion, sentiment, stress, or personality inference on the prospect. Classify *what was said*, never *how they feel*. EU AI Act line, not a preference.

### 6.4 Playbook

```yaml
- id: price-too-high
  trigger: price_objection
  headline: "Compared to what?"
  line: "Ask what they're comparing against before defending the number."
  detail: |
    ...longer text, shown only on tap...
```

Load from `playbook/*.yaml`, embed at boot, keep in memory. Content is the moat; the plumbing isn't. Structure so plays are added without touching code. **10–15 real plays for v1. Not 200 generated ones.**

---

## 7. Latency budget

| Stage | Transport A | Transport B |
|---|---|---|
| Capture → pipeline | ~100–200ms (network) | ~10–30ms (localhost) |
| Soniox partial → final | ~200–400ms | ~200–400ms |
| Turn-end debounce | ~600ms (tunable) | ~600ms (tunable) |
| Tier 1 classify | < 200ms | < 200ms |
| Retrieval | < 50ms | < 50ms |
| Tier 2 generate | < 600ms | < 600ms |
| **Prospect stops → card on screen** | **< 1.5s** | **< 1.3s** |

Timestamp every stage on the suggestion payload, tagged with `transport`. If you can't see the breakdown per transport, you can't tune either.

---

## 8. Operator UI

The hardest product problem here, and the one most likely to be under-built.

- A rep on a live call reads **~6 words**. Card = headline (≤6 words) + one line. Detail behind a tap.
- One card visible. New suggestion replaces, doesn't stack.
- Live transcript in a secondary panel — small, ignorable.
- Visual cue only. No audio/haptic; the rep is on a call.
- **Transport-aware chrome:**
    - Mode selector: PSTN / System audio.
    - Health: media WS + per-speaker Soniox session status.
    - Transport B only: consent affirmation gate, persistent recording indicator, announcement script, headset/echo warning.

---

## 9. Build order

1. **Skeleton + config.** Fastify, zod, boot-time EU-endpoint assertion.
2. **`AudioSource` interface + `CallSession`.** Write against the seam from the start. Ship a `FileAudioSource` (reads a wav, emits frames) — this is your test harness for everything downstream and it costs 30 minutes.
3. **Wire the existing Electron capture into `SystemAudioSource`.** It's already built; this is the fastest path to a live end-to-end loop. Verify sample-count timestamps and 16kHz.
4. **One Soniox session** (prospect only), via Transport B. Print live transcript. **Measure Polish WER here on real audio.** This is the kill-check — if it's unusable, everything downstream is moot.
5. **Second session** (rep). Interleave into transcript store.
6. **TurnDetector.** Tune the debounce against real calls.
7. **Tier 1 classifier**, rules only. Console output.
8. **Playbook + retrieval.** Console output.
9. **Tier 2 generation.**
10. **UI.** Last — by now you know the payload shape.
11. **Transport A: Twilio dial + bridge, no streaming.** Prove you can call two phones. Verify `answerOnBridge` ringback.
12. **Transport A: consent announcement** on the prospect leg.
13. **Transport A: `TwilioAudioSource`.** **Empirically verify which track is the prospect** — dump 10s of each to wav and listen. Then it drops into the existing pipeline unchanged.
14. **Teardown, reconnect, health, error paths — both transports.**

Note the reorder from the PSTN-only plan: because system capture already exists, Transport B is now the fastest route to the step-4 kill-check. Do not build Twilio first just because it was written first.

---

## 10. Config (`.env`)

```
# Pipeline
SONIOX_API_KEY=            # EU project key
SONIOX_WS_URL=             # EU endpoint — asserted at boot
TURN_END_DEBOUNCE_MS=600
PERSIST_TRANSCRIPTS=false
CONSENT_ANNOUNCEMENT_PL=   # TODO: legal review — used by BOTH transports

# Transport A
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_NUMBER=
TWILIO_REGION=ie1
TWILIO_EDGE=dublin
OPERATOR_NUMBER=
PUBLIC_URL=                # ngrok https URL

# Transport B
SYSTEM_AUDIO_WS_PORT=8788
REQUIRE_HEADSET_ACK=true
```

**Security:** validate Twilio webhook signatures (`twilio.validateRequest`) on every `/voice/*` route. The media WS is unauthenticated by default — pass a signed token via `<Parameter>`, verify on `start`. Bind the Transport B WS to `127.0.0.1` only.

---

## 11. Open questions for the human

- [ ] Legal review of the consent announcement wording + two-party consent under Polish law.
- [ ] **Transport B consent gap (§5.5)** — accept the procedural control, or restrict B to internal/consented calls only? This is a decision, not a task.
- [ ] Soniox EU region is **enabled by request** — confirm active on the account before step 4.
- [ ] DPA: countersign in Soniox Console → Security & compliance. Same for Twilio.
- [ ] Polish WER on 8kHz (A) vs 16kHz (B) — expect a real gap. Does A clear the usability bar at all?
- [ ] Mixed-channel handling in B: raise threshold, or add diarization? (§6.3)
- [ ] Retention policy if `PERSIST_TRANSCRIPTS=true` ever ships.
