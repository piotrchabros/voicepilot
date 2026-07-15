# Manual QA checklist — Task 4.2 (Transport chrome finalization)

Source of truth for the "手動 QA チェックリスト全項目 pass（スクリーンショット
evidence）" DoD on Plans.md Task 4.2. Covers the overlay chrome introduced by
Task 2.4 (health banner), Task 4.1 (consent gate + REC), and this task's mode
chip + suggestion-card hierarchy (spec.md §5: "Transport chrome: mode
selector, health banners..., and Transport-B consent gate + recording
indicator").

Run with `npm run app` (builds + launches the Electron overlay) unless a step
says otherwise. Attach one screenshot per item to the task's review artifact
(or the PR closeout evidence pack) as the "スクリーンショット evidence."

`not_observed != absent` (docs/compliance.md convention): if a step can't be
run in the current environment (e.g. no sidecar binary), record it as
**unknown / not run**, not as a silent pass.

## Checklist

### (a) Startup shows the consent prompt, capture has not started

1. `npm run app`
2. Observe the overlay window on launch.

**Expect**: the consent prompt (`#consent-prompt`, centered) is visible with
the announcement script and an "I have obtained / will announce consent"
button. The REC indicator (`#rec-indicator`) is **not** visible. The mode chip
(`#mode-chip`, top-left, "System audio") **is** visible — it is always-on,
independent of consent state.
**Verify**: screenshot of the initial window; confirm no `[gate] recording
started` (or equivalent capture-start) log line has appeared yet in the
terminal running `npm run app`.

### (b) Affirm → REC indicator + mode chip, capture starts

1. From state (a), click the affirm button.

**Expect**: the consent prompt disappears; the REC indicator (red dot + "REC"
label) appears immediately below/beside the mode chip in the top-left
transport chrome, and stays up. The mode chip continues to read "System
audio".
**Verify**: screenshot showing both the mode chip and REC indicator visible
together, non-overlapping. Confirm (via terminal log or
`SystemAudioSource`/sidecar start signal) that capture began only after this
click, not before.

### (c) Hint pill: RETRIEVED two-line display, overwritten by GENERATED

1. With capture running (state (b)), speak/feed audio that triggers a
   playbook match (RETRIEVED) — e.g. mention a known objection keyword from
   `src/pipeline/playbook.ts`'s entries.
2. Keep talking until the LLM speculation lands (GENERATED) and overwrites it.

**Expect**: while RETRIEVED is showing, the pill shows two lines — a bold
headline on top, a thinner/dimmer detail line below (per `hintDisplayFor` /
spec.md §5 "headline ≤6 words + one line"), both dimmed relative to the
GENERATED state. Once GENERATED lands, the pill collapses to a single bold,
full-brightness line, and the detail line disappears (no leftover blank
gap — see `#pill:not(.two-line) #hint-line { display: none }`).
**Verify**: two screenshots — one mid-RETRIEVED (two-line, dimmed), one
post-GENERATED (single-line, bright) — same manual/bench session.

### (d) Health banner: sidecar kill shows a red banner, auto-dismisses after 10s

1. With capture running, kill the capture sidecar process out from under the
   app (e.g. `pkill -f <sidecar binary name>` — see `src/main/sidecar.ts` /
   `native/capture` for the binary name) — or unplug/disable the capture
   device, whichever health source is easiest to trigger locally.
2. Observe the top-center health pill (`#health-pill`).
3. Start a stopwatch from when the banner appears.

**Expect**: a red pill appears top-center within ~1s of the failure event,
showing the `ok:false` detail text. If no recovery (`ok:true`) event arrives,
it auto-dismisses ~10s later (`HEALTH_BANNER_TIMEOUT_MS` in `overlay.ts`) even
without one, per Task 2.4.
**Verify**: screenshot at appearance, and either a screenshot/timestamp log
confirming dismissal at ~10s, or (if a recovery event fires first) a
screenshot with the banner gone immediately after the `ok:true` event,
whichever happens first — note which case was observed.

### (e) Hint pill, health banner, and REC/mode chip never overlap

1. Trigger (c) and (d) simultaneously (or in close succession so both are
   visible at once), with the REC indicator + mode chip already up from (b).

**Expect**: hint pill (bottom-center), health banner (top-center), and
top-left transport chrome (mode chip + REC) occupy visually distinct regions
of the window at all times — no visual overlap or clipping, at the window's
default size.
**Verify**: one screenshot with all three regions populated at once.

### (f) `COPILOT_NO_PROTECT=1` allows screenshot evidence to be captured

1. Run `COPILOT_NO_PROTECT=1 npm run app` instead of the plain `npm run app`.
2. Take a screenshot of the overlay using normal OS screenshot tooling.

**Expect**: without this flag, `win.setContentProtection(true)` (default,
`src/main/index.ts`) excludes the overlay from OS screen capture/screenshots —
by design, so a real call's screen share never leaks the overlay. With the
flag set, `setContentProtection` is disabled (logged as `[gate] content
protection DISABLED (COPILOT_NO_PROTECT=1)`), so the screenshots for items
(a)–(e) above can actually be captured. This flag is for internal QA/demo use
only — never set it for a real-prospect call.
**Verify**: confirm the `[gate] content protection DISABLED
(COPILOT_NO_PROTECT=1)` log line appears; confirm a screenshot taken this way
actually shows the overlay content (vs. a blank/transparent capture without
the flag).

### (g) No call content appears in logs with `COPILOT_DEBUG` off

1. Run the app normally (`COPILOT_DEBUG` unset, or `COPILOT_DEBUG=0`) through
   a full call segment that produces transcript turns, classifications, and
   hints.
2. Inspect the terminal/log output for that session.

**Expect**: no transcript text, hint text, or classification transcript
snippets appear anywhere in the logs — per spec.md §4.4 log hygiene, pinned at
the unit level by `formatTurnEndLog`/`formatHintLog`/`formatClassificationLog`
(`test/log-hygiene.test.ts`). Structural/telemetry lines (frame counts,
classification label + confidence, health events, gate state) are fine and
expected.
**Verify**: `grep` the captured log output for any known transcript/hint
substring used during the session and confirm zero matches; attach the log
excerpt (redacted structural lines only) as evidence instead of a screenshot
for this item.

## Automated coverage referenced by this checklist

- `test/hint-view.test.ts` — `hintDisplayFor` headline/line split (item c).
- `test/mode-chip.test.ts` — `modeLabelFor` labels (items a/b/e).
- `test/health-banner.test.ts` — `bannerStateFor` (item d).
- `test/consent-view.test.ts` — consent prompt / REC visibility (items a/b).
- `test/log-hygiene.test.ts` — log content gating (item g).

These pin the pure display-logic decisions; the DOM wiring, timers, real
sidecar/device failures, and OS-level screenshot behavior itself are not
unit-testable and remain manual (hence this checklist, per
`[tdd:skip:ui-manual-qa]`).
