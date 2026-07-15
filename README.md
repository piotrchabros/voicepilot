# copilot

Real-time conversation copilot. Fully local, macOS, Java 21+.

Listens to both legs of a call, speculatively generates a hint on every interim
transcript update, and shows it before the other person has finished talking.

Compliance/legal blocker status (Soniox/Twilio DPAs, consent wording, EU region) is tracked in [`docs/compliance.md`](docs/compliance.md) — real-prospect calls are gated on it.

## The one idea

The serial path — VAD → STT → turn-end → LLM → render — is 400-800ms and cannot
be made faster. So don't wait for the turn to end. Generate continuously on
partial transcripts, cancel constantly, throw away 90% of the work. By the time
they stop talking, the answer has been on screen for half a second.

This only works locally. On a metered API, 10 speculations per turn is a bill and
a rate limit. On your own GPU it's fan noise.

## Setup

**1. Audio routing** (this is the annoying bit)

```bash
brew install blackhole-2ch
```

Then in **Audio MIDI Setup.app**:
- Create a **Multi-Output Device** = BlackHole 2ch + your speakers/headphones
- Set it as your system output — you still hear the call, BlackHole gets a copy
- In Zoom/Meet, leave your mic as the built-in mic

Verify Java can see both:
```bash
mvn -q compile exec:java -Dexec.args="--list-devices"
```
Adjust the device-name fragments in `Main.java` to match.

**2. Models** → `~/models/`

- `silero_vad.onnx` — github.com/snakers4/silero-vad (v5; v4 has a different signature)
- `zipformer-streaming/` — github.com/k2-fsa/sherpa-onnx/releases
  Pick a **streaming** model whose language list covers Polish. Needs
  `encoder.onnx`, `decoder.onnx`, `joiner.onnx`, `tokens.txt`.
- A GGUF, e.g. `Qwen3-4B-Instruct-Q4_K_M.gguf`

**3. llama-server**

```bash
llama-server -m ~/models/Qwen3-4B-Instruct-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8080 \
  --n-gpu-layers 99 \
  --parallel 1 \
  --ctx-size 8192 \
  --cache-reuse 256
```

`--parallel 1` is not a typo. One slot = one KV cache = it stays warm.

**4. playbook/*.yaml**

Each file under `playbook/` declares one or more plays as
`{ id, trigger, headline, line, detail?, phrases }` — `trigger` must be one of
the Tier-1 labels in `src/pipeline/classifier.ts`; `phrases` are the trigger
phrase(s) (including inflected variants) matched via char-trigram cosine
(`src/pipeline/playbook.ts`):

```yaml
entries:
  - id: price_objection_status_quo
    trigger: price_objection
    headline: Cena vs koszt zwłoki
    line: zapytaj o koszt status quo
    phrases:
      - za drogo
      - za drogie
      - za drogi
  - id: authority_objection_team_decides
    trigger: authority_objection
    headline: Kto jeszcze decyduje
    line: umów ich na call
    phrases:
      - muszę pogadać z zespołem
```

**5. Run**

```bash
mvn clean compile javafx:run
```

## Secrets

Copy .env.example to .env and fill in only what you need (all keys optional); it's validated fail-fast by `src/main/env.ts` (zod) on boot — the deprecated .soniox-key file fallback now warns and checks for chmod 600.

## Lint

Formatting/linting is [Biome](https://biomejs.dev), configured in `biome.json`
(scoped to `src/`, `test/`, `scripts/`; `out/`, `node_modules/`, `native/`, and
`openwiki/` are excluded):

```bash
npm run lint          # biome check . — formatter + linter, exit 0 required
npm run format:check  # biome format . — formatting only, no writes
```

`noExplicitAny` and `noNonNullAssertion` are off because this codebase leans on
`any`/`!` at native-binding boundaries (sherpa-onnx-node, onnxruntime-node) where
TypeScript can't see the real shape — banning them would just relocate the
unsafety behind `as any` casts, not remove it.

## Measure before you optimise

Log a timestamp at each stage boundary and print the p50/p95. Everything about
this design is a guess until you have your own numbers:

```
frame_in → vad_out → stt_interim → speculate_fired → first_token → painted
```

The number that will surprise you is not TTFT. It's `HANGOVER_MS` in
`SileroVad` — 250ms of pure, unavoidable, additive latency on every single
hint. It's the largest single line item in the budget. Halving it does more than
any model swap.

## Known issues / the honest list

- **Whisper is not here on purpose.** It's a 30-second encoder-decoder. Every
  "streaming Whisper" is re-encoding a growing buffer and calling 1-5s real-time.
- **Polish WER is the real risk.** Every benchmark you'll read is English. Record
  20 minutes of your actual calls and measure before committing to any engine.
- **The overlay is visible in screen share.** Needs `NSWindow.sharingType = .none`,
  not reachable from JavaFX. Fix = rewrite `Overlay` as a Swift app on a socket.
- **`AudioCapture` resampling is a box filter.** Fine for speech. If WER looks bad,
  suspect this before you blame the model.
- **Thermals.** Sustained inference spins the fans, the fans feed your mic, your
  mic feeds the STT. You built a feedback loop. Watch for it.
- **RAM.** Zoom + Chrome + 4B model + 2× STT. 16GB will not do it. 32GB+.
- **sherpa-onnx Java bindings move.** If the class names in `SherpaStt` don't
  resolve, check `java-api-examples` in that repo. The concepts are stable even
  when the names aren't.

## v2 seam

`Overlay` and `AudioCapture` both want to be one small Swift sidecar
(ScreenCaptureKit capture + an NSWindow excluded from capture), piping PCM in and
hints out over a socket. That kills the BlackHole dependency and the screen-share
leak in one move. Java keeps everything that matters — state, turn logic,
speculation, retrieval, prompts.

Don't build that first. Build this, use it on ten real calls, find out whether
glanceable hints are even usable mid-conversation. That's the actual risk here,
and it's not a technical one.
