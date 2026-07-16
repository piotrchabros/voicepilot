# Phase 5 merge note — AnalysisEngine / AnalysisMsg / analysis IPC (Task 6.9)

spec.md §6 (Process topology): *"Now: everything stays in the Electron app
(sidecar → main → utilityProcess). When Transport A starts: lift
`src/pipeline` into a standalone Node service (Fastify; serves TwiML
webhooks, media WS, Electron WS, UI WS) and the Electron app becomes a thin
capture-forwarder client. Not before."*

spec.md §7 (Knowledge base & analysis engine): *"`AnalysisEngine` is a
sibling of `HintEngine` in `src/pipeline` (transport-agnostic; rides the
Phase-5 service lift unchanged)."*

This records, at the point Phase 6 (Tasks 6.1–6.9) is functionally complete,
exactly what rides the future Phase-5 Fastify lift unchanged and what stays
Electron-side, so that lift (when Transport A starts) does not need to
re-litigate any of Phase 6's design decisions.

## What rides the lift unchanged

- **`src/pipeline/analysis-engine.ts` (`AnalysisEngine`).** No Electron
  imports (same header comment states this explicitly: "Transport-agnostic,
  no Electron imports, so it rides the Phase-5 Fastify lift unchanged,
  exactly like HintEngine"). Depends only on `AnalysisLlm` (vendor-agnostic
  interface, `src/pipeline/analysis-llm.ts`), `KnowledgeBase`
  (`src/pipeline/knowledge.ts`), and `TranscriptState`
  (`src/pipeline/transcript-state.ts`) — all three are themselves
  Electron-free.
- **`src/pipeline/analysis-prompts.ts`, `src/pipeline/knowledge.ts`,
  `src/pipeline/cloud-llm-client.ts`.** Same rule: no Electron imports,
  pure/testable, lift unchanged.
- **`AnalysisMsg`/`Analysis`/`AnalysisStage`** (`src/shared/types.ts`). The
  wire-shape SSOT is explicit about this in its own doc comment: `Analysis`
  "must stay plain-serializable JSON (no class instances, no functions, no
  `Date` objects) so it survives today's `utilityProcess.postMessage()`
  structured-clone AND a JSON-over-WebSocket bridge in Phase 5.1 unchanged."
  Verified structurally: every field is a string/string-array/number, no
  methods, no `Date`. `AnalysisMsg` (`{ type: 'analysis', analysis: Analysis }`)
  is the same shape, so it survives a plain `JSON.stringify`/`JSON.parse`
  round-trip identically to a structured-clone round-trip — nothing here
  needs to change when the transport becomes a WS bridge instead of
  `postMessage`.
- **`InitMsg.knowledgeDir`/`InitMsg.customersDir`** (`src/shared/types.ts`).
  Both are explicitly **path-only** fields — the doc comments say so
  directly ("Only a filesystem path crosses this boundary — brief content
  itself is loaded fresh on the pipeline side, never pre-read into
  InitMsg"). A Fastify service reachable from a different filesystem
  context only needs these two strings resolved to wherever
  `knowledge/`/`customers/` live for that deployment — no shape change.

## What stays Electron-side (does NOT ride the lift)

- **`src/main/*` config/paths resolution** (`knowledgeDir()`,
  `customersDir()`, `paths.*` in `src/main/config.ts`) — these resolve
  `app.getAppPath()`/`process.cwd()`, Electron-specific. The Fastify service
  will need its own path-resolution entry point; the *values* it produces
  (plain strings) are what crosses into `InitMsg`, not the resolution logic
  itself.
- **`src/main/index.ts`'s panel window wiring** (`onAnalysis`, the
  content-protected analysis panel `BrowserWindow`, Cmd+Shift+A toggle) —
  `BrowserWindow`/`ipcMain`/`contextBridge` are Electron-only by
  definition. Post-lift, this becomes the "thin capture-forwarder client"
  spec.md §6 describes: it still owns the panel window and still receives
  `AnalysisMsg`-shaped data, but over the new WS bridge instead of
  `utilityProcess.postMessage()`.
- **`src/preload/panel.ts`** (`CopilotBridge.onAnalysis`) — `contextBridge`
  is Electron-only; stays as the renderer-facing surface regardless of what
  transport feeds it.
- **`src/main/bench.ts`'s `--bench` harness** (including this task's
  two-pass analysis/card-path bench extension) is an Electron CLI dev tool
  (`electron . --bench <wav>`) — it will need its own post-lift equivalent
  (or continue to exist as an Electron-hosted dev harness against a running
  Fastify service) but is not itself part of the lifted surface.

## Verification performed for this note (Task 6.9)

- Grepped `src/pipeline/analysis-engine.ts`, `analysis-prompts.ts`,
  `knowledge.ts`, `cloud-llm-client.ts` for `from 'electron'` imports — none
  found.
- Confirmed `AnalysisEngine`'s constructor/method signatures take only
  `AnalysisLlm`/`KnowledgeBase`/`TranscriptState`/plain callbacks — no
  `BrowserWindow`/`ipcMain`/`utilityProcess` reference anywhere in the file.
- Re-read `Analysis`/`AnalysisMsg`/`InitMsg.knowledgeDir`/
  `InitMsg.customersDir` doc comments in `src/shared/types.ts` (Tasks
  6.1/6.4/6.5/6.7) — all four already state the Phase-5/WS-bridge
  survivability contract explicitly; this note aggregates and cites them
  rather than re-deciding anything.

No code changes were required to satisfy this note — Tasks 6.1–6.7 already
built `src/pipeline`'s Phase-6 surface transport-agnostic by design; this is
the recorded confirmation spec.md §7 calls for.
