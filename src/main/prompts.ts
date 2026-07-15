// Prompt context, lifted verbatim from Main.java. These strings are part of the
// immutable cached prefix — if you edit them, do it once and never per-turn.

export const SYSTEM_PROMPT = `You are a live sales-call copilot. You see a running transcript of a call.
Output ONE hint of at most 8 words telling the seller what to say or ask next.
No preamble, no explanation, no quotes. Just the hint.
Match the language of the transcript.
If nothing useful applies, output exactly: -
`

// Whatever static context you want cached forever: ICP, pricing, objections, your
// differentiators. Costs nothing per turn — it's in the warm prefix.
export const STATIC_CONTEXT = `<context>
Bespokesoft: software house. AI, ERP/CRM, Open Mercato.
</context>`

/** How many settled turns to keep before the one-time reset (grow-then-reset). */
export const MAX_TURNS = 12
