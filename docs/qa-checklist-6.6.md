# Manual QA checklist — Task 6.6 (Analysis panel window)

Source of truth for the "手動 QA チェックリスト pass（content-protection A/B、
default hidden、card 無変更、スクリーンショット evidence）" DoD on Plans.md
Task 6.6. Covers the second, separately content-protected analysis panel
window (spec.md §5 "Phase 6 adds a second, separately content-protected
analysis panel window"; §7 "Knowledge base & analysis engine"), plus the
deferred Task 6.7 browser-QA item (customer-brief dropdown render/lock).

Run with `npm run app` (or `COPILOT_NO_PROTECT=1 npm run app` for capturable
screenshots — see item (c)) unless a step says otherwise. Attach one
screenshot per item to the task's review artifact (or the PR closeout
evidence pack) as the "スクリーンショット evidence."

`not_observed != absent` (docs/compliance.md convention): if a step can't be
run in the current environment (e.g. no Accessibility permission for
automated keystroke/click injection, no sidecar binary), record it as
**unknown / not run**, not as a silent pass. Several items below are marked
**[user-run]** for exactly this reason — automated boot evidence was
captured this pass (`docs/qa-evidence/6.6-boot-overlay.png`), but this
harness run's shell has no macOS Accessibility permission to send System
Events keystrokes/clicks, so interactive steps (shortcut toggle, button
clicks) could not be captured automatically. `[panel:ready] renderer
subscribed (analysisEnabled=...)` in the terminal log is the automated proxy
confirming the panel window loads and its bridge wires up correctly even
though its visibility couldn't be toggled by this pass.

## Checklist

### (a) Default hidden — panel window is created but never shown at boot

1. `COPILOT_NO_PROTECT=1 LLM_ANALYSIS_ENABLED=1 npm run app`
2. Observe the screen for a few seconds after boot.

**Expect**: only the existing bottom-centre hint card (overlay window) and
its consent prompt appear. No analysis panel is visible anywhere on screen —
`createPanel()` (`src/main/index.ts`) always constructs the panel with
`show: false`, and nothing in the boot path calls `.show()`/`.showInactive()`
on it.
**Verify**: `[panel:ready] renderer subscribed (analysisEnabled=true)`
appears in the terminal log (proves the panel's webContents loaded and its
preload bridge fired, independent of visibility) with no corresponding
window ever appearing on screen. Screenshot the desktop at this point —
**automated evidence**: `docs/qa-evidence/6.6-boot-overlay.png` (captured
this pass via `screencapture -x`; only the hint-card overlay + consent
prompt are visible, confirming the panel stayed hidden).

### (b) Toggle: Cmd+Shift+A shows/hides the panel — **[user-run]**

1. From state (a), press **Cmd+Shift+A**.
2. Press it again.

**Expect**: the first press shows the analysis panel (top-right region of
the work area, `positionPanelRight()` in `src/main/index.ts` — clear of the
bottom-centre hint card, top-center health banner, and top-left transport
chrome). The panel shows either "analysis disabled" (flag off) or "awaiting
analysis…" (flag on, no turn analyzed yet) — see item (g). The second press
hides it again. No dock/taskbar icon appears for the panel at any point.
**Verify**: two screenshots — panel visible, panel hidden again.
**Not run automatically this pass**: this harness's shell has no
Accessibility permission to send System Events keystrokes
(`osascript ... System Events got an error: Connection is invalid (-609)`,
captured in this task's worker session) — the shortcut registration itself
was confirmed successful (`globalShortcut.register` returns `true`, no
`[panel] failed to register global shortcut` log line appeared at boot), but
the actual keypress could not be injected non-interactively.

### (c) Content-protection A/B on the panel — **[user-run]** (screen-share/screenshot test)

1. Run plain `npm run app` (protection **on**, the default). Show the panel
   (item (b)) and start a screen share or take an OS screenshot.
2. Run `COPILOT_NO_PROTECT=1 npm run app` instead. Show the panel again and
   repeat the capture.

**Expect**: with protection on (default), `win.setContentProtection(true)`
on the panel window (`createPanel()`, same recipe as `createOverlay()`)
excludes it from OS screen capture/screenshots/screen-share — by design, so
a real call's screen share never leaks analysis content, exactly like the
existing hint card. With `COPILOT_NO_PROTECT=1`, protection is disabled on
**both** windows (each logs its own gate line — see item (d)) so the panel
becomes capturable too.
**Verify**: confirm the panel is invisible in a capture/share taken under
plain `npm run app`, and visible in one taken under
`COPILOT_NO_PROTECT=1 npm run app`. This flag is for internal QA/demo use
only — never set it for a real-prospect call (mirrors
docs/qa-checklist-4.2.md item (f)).

### (d) Both content-protection gate log lines fire independently

1. `COPILOT_NO_PROTECT=1 npm run app`
2. Inspect the terminal output at boot.

**Expect**: two distinct log lines, one per window — `[gate] content
protection DISABLED (COPILOT_NO_PROTECT=1)` (overlay, unchanged wording from
Task 1) and `[gate] panel content protection DISABLED
(COPILOT_NO_PROTECT=1)` (panel, Task 6.6) — proving the panel applies its
own `setContentProtection`/`COPILOT_NO_PROTECT` recipe rather than silently
inheriting the overlay's.
**Verify — automated this pass**: both lines observed in the terminal log
during this task's boot run (`/tmp/panel-app-boot2.log`, not committed —
transient QA session output):
```
[gate] content protection DISABLED (COPILOT_NO_PROTECT=1)
[gate] panel content protection DISABLED (COPILOT_NO_PROTECT=1)
```

### (e) Hint card stays unchanged — no regression to Task 4.2's chrome

1. `COPILOT_NO_PROTECT=1 COPILOT_PLACEHOLDER=1 npm run app`
2. Observe the bottom-centre hint card, top-left transport chrome (mode chip
   + REC), top-center health banner region, and consent prompt exactly as in
   docs/qa-checklist-4.2.md.

**Expect**: pixel-for-pixel identical to 4.2's checklist — `createOverlay()`,
`src/renderer/overlay.ts`, `overlay.css`, and `index.html` are byte-for-byte
untouched by this task (only `src/main/index.ts`'s `paintAnalysis()` gained
two additive lines forwarding to the new panel; nothing in the overlay's own
render path changed).
**Verify — automated this pass**: `docs/qa-evidence/6.6-boot-overlay.png`
shows the consent prompt (with the Task 6.7 customer-brief dropdown, item
(h) below), mode chip ("System audio"), and placeholder hint pill exactly as
docs/qa-evidence/4.2-boot-chrome.png did — no visual regression observed.
Re-run docs/qa-checklist-4.2.md items (a)-(g) for full confidence if this
task's diff is suspected of a regression (not expected, given the untouched
files above).

### (f) Refresh-now button re-renders the latest analysis

1. Show the panel (item (b)) with `LLM_ANALYSIS_ENABLED=1` and a working
   cloud LLM config, and let at least one analysis result arrive (panel
   shows a stage + suggested questions, not "awaiting analysis…").
2. Click the "Refresh now" button.

**Expect**: the panel re-renders the same (most recently received) analysis
content immediately — no flicker to the empty state, no crash — and any
stale grey-out (item (g)) clears immediately after the click, since the
click itself re-evaluates staleness against `Date.now()`
(`src/renderer/panel.ts`'s refresh handler calls `render()` right after
`window.panel.refreshNow()`). **Scope note**: `AnalysisEngine`
(`src/pipeline/analysis-engine.ts`) exposes no public re-trigger method as of
this task (out of scope this wave — the task briefing explicitly excludes
modifying that file) — "refresh now" is a re-render-latest operation, not a
request for a brand-new cloud LLM call. This is documented in
`src/main/index.ts`'s `panel:refresh` handler and `panel.ts`'s click handler
comments.
**Verify — [user-run]**: click the button, screenshot before/after (staleness
clears if it had gone stale). Could not be exercised this pass — requires
both an interactive click (see item (b)'s Accessibility-permission note) and
a working `LLM_API_URL`/`LLM_API_KEY` configuration in this environment,
neither of which were available.

### (g) Stale grey-out — time-based threshold

1. With an analysis showing in the panel (as in item (f)), leave the panel
   open and idle (no new analysis arrives — e.g. pause the conversation) for
   longer than `STALE_THRESHOLD_MS` (30s, `src/renderer/panel-view.ts`).

**Expect**: the panel body (stage/questions/next-steps/stamp) visibly greys
out (`#panel.stale #panel-body { opacity: 0.45 }`, `panel.css`) once 30s have
elapsed since the analysis was received, without requiring a click or new
data. The cloud indicator and header stay at full opacity (only `#panel-body`
dims) so the operator can still tell at a glance that cloud processing is
active. **Scope note** (documented in `panel-view.ts`'s
`STALE_THRESHOLD_MS` comment): spec.md §7 also lists "a newer settled turn
exists than the analysis's asOfTurn" as a staleness trigger; this task's
panel always renders the most recently *received* analysis, so that
condition is naturally satisfied as soon as a fresher result lands — there
is no separate "conversation moved on, no new analysis yet" signal on the
wire as of this task (would require exposing the live turn count outside
`AnalysisEngine`, out of this task's scope). The time-threshold behavior
below is the tested, honest approximation actually shipped.
**Verify — automated (pure logic) this pass**: `test/panel-view.test.ts`
pins the exact threshold behavior (`stale: true` past 30s, `stale: false` at
or under it, custom threshold override) without needing a live window.
**[user-run]** for the visual grey-out itself: could not be exercised this
pass (same Accessibility-permission blocker as items (b)/(f) — showing the
panel requires the toggle shortcut).

### (h) Empty / disabled states — honest, never a blank crash

1. `COPILOT_NO_PROTECT=1 npm run app` (no `LLM_ANALYSIS_ENABLED` set — the
   default). Show the panel (item (b)).
2. Then `COPILOT_NO_PROTECT=1 LLM_ANALYSIS_ENABLED=1 npm run app` (flag on,
   before any analysis has arrived). Show the panel again.

**Expect**: (1) with the flag off, the panel shows "analysis disabled" (not
a blank panel, not "awaiting…") — this is `panelViewModelFor`'s
`emptyReason: 'disabled'` branch, which the flag check wins over any
(impossible in practice) stale analysis object, per
`test/panel-view.test.ts`'s defensive coverage. (2) with the flag on but no
turn analyzed yet, the panel shows "awaiting analysis…" — the
`emptyReason: 'awaiting'` branch. Neither case shows an empty flash, a
crash, or leftover content from a previous run.
**Verify — automated (pure logic) this pass**: both branches (and the
cloud-indicator visibility that accompanies each — item (i)) are pinned in
`test/panel-view.test.ts`. **[user-run]** for the visual confirmation: same
Accessibility-permission blocker as item (b).

### (i) Cloud-processing indicator — "analogous to REC"

1. Boot with `LLM_ANALYSIS_ENABLED` unset/`0` — observe the panel's
   `#cloud-indicator`.
2. Boot with `LLM_ANALYSIS_ENABLED=1` — observe it again.

**Expect**: the blue "CLOUD" pill (`#cloud-indicator`/`#cloud-dot`/
`#cloud-label`, `panel.css` — deliberately styled distinctly from the
overlay's red REC dot so the two are never visually confused) is hidden when
the flag resolved false, and visible when it resolved true — driven by
`PanelInitMsg.analysisEnabled`, sent once on `panel:ready` (spec.md §7
"visible marker when LLM_ANALYSIS_ENABLED resolved true, analogous to the
REC indicator").
**Verify — automated this pass**: terminal log line
`[panel:ready] renderer subscribed (analysisEnabled=true)` confirms the flag
resolved correctly and was about to be sent to the panel when booted with
`LLM_ANALYSIS_ENABLED=1` in this task's QA session; `analysisEnabled=false`
(line omitted above) was observed in the earlier boot without the env var
set. `test/panel-view.test.ts`'s `cloudActive` assertions pin the pure
mapping from the flag to indicator visibility. **[user-run]** for the visual
pill itself: same Accessibility-permission blocker as item (b).

### (j) Deferred Task 6.7 item — customer-brief dropdown renders + locks after affirm

1. `COPILOT_NO_PROTECT=1 npm run app`. Observe the consent prompt's
   "Customer brief" dropdown before affirming.
2. Click "I have obtained / will announce consent" — **[user-run]** for step
   2's click itself.

**Expect**: (1) before affirm, the dropdown (`#customer-brief-select`,
`overlay.ts`'s `renderCustomerBriefOptions`) is enabled and shows "none"
first/selected, followed by any `customers/*.md` basenames found at boot
(`listCustomerBriefs`, `src/main/index.ts`). (2) after affirm, the dropdown
is `disabled` and the selection can no longer be changed — locked in per
spec.md §7 "chosen once, pre-Start... no mid-call switching" —
`customerBriefSelect.disabled = consentState === 'affirmed'` fires both from
the click handler AND from a reload mid-call via `renderCustomerBriefOptions`
reading `consentState` (Task 6.7 reviewer finding MINOR D).
**Verify — automated this pass**: `docs/qa-evidence/6.6-boot-overlay.png`
shows the pre-affirm state — the "Customer brief [none ▾]" dropdown is
visibly rendered and enabled in the consent prompt, satisfying half of this
item's browser-QA request non-interactively. The post-affirm locked state is
pinned at the pure-logic level by
`test/consent-view.test.ts` ("is hidden once affirmed" /
"is visible (persistent) once consent is affirmed" — the same
`consentState === 'affirmed'` predicate the disabled-attribute derivation
uses). The DOM-level click-through itself is **[user-run]**: same
Accessibility-permission blocker as item (b) prevented an automated click.

## Automated coverage referenced by this checklist

- `test/panel-view.test.ts` — `panelViewModelFor` empty/disabled/awaiting
  states, stale-threshold boundary, `stageLabelFor` mapping, honest
  "as of turn N (retained)" stamp wording (items f/g/h/i).
- `test/panel-bridge.test.ts` — `buildPanelBridge`'s narrow IPC surface
  (analysis + panel-init only; refreshNow/ready send the right channels).
- `test/consent-view.test.ts` — pre-existing coverage for the
  affirmed/pending predicate the customer-brief dropdown's `disabled`
  derivation reuses (item j).
- `docs/qa-evidence/6.6-boot-overlay.png` — automated boot screenshot
  (`screencapture -x`, `COPILOT_NO_PROTECT=1`) showing the unchanged hint
  card, consent prompt, and customer-brief dropdown, with the analysis panel
  correctly absent (default-hidden, item a).

These pin the pure display-logic and IPC-surface decisions; the DOM wiring
inside the panel window, the global-shortcut toggle, real screen-share/
screenshot behavior, and button clicks remain manual — this pass's shell had
no macOS Accessibility permission to script them, so those specific items are
marked **[user-run]** above rather than silently marked pass (per the
`not_observed != absent` convention).
