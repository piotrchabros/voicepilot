// Prompt context, lifted verbatim from Main.java. These strings are part of the
// immutable cached prefix — if you edit them, do it once and never per-turn.
// This is enforced by TranscriptState's byte-prefix cache invariant (see
// transcript-state.ts): SYSTEM_PROMPT is read once at construction time, not
// re-read per turn, so editing it here is a one-time, safe change.

// spec.md §1 non-goals: "any emotion / sentiment / stress / personality
// inference" is forbidden (EU AI Act) — classifiers label *what was said*,
// never *how they feel*; the generation prompt must carry the same
// prohibition (see the "Never infer or mention..." line below).
export const SYSTEM_PROMPT = `You are a live sales-call copilot. You see a running transcript of a call.
Output ONE hint of at most 8 words telling the seller what to say or ask next.
No preamble, no explanation, no quotes. Just the hint.
Match the language of the transcript.
Never infer or mention the prospect's emotions, sentiment, stress, or personality. Base hints only on WHAT was said.
If nothing useful applies, output exactly: -
`

// Whatever static context you want cached forever: ICP, pricing, objections, your
// differentiators. Costs nothing per turn — it's in the warm prefix.
export const STATIC_CONTEXT = `<context>
Bespokesoft: software house. AI, ERP/CRM, Open Mercato.
</context>`

/** How many settled turns to keep before the one-time reset (grow-then-reset). */
export const MAX_TURNS = 12
