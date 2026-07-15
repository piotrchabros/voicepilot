// Directly test the LLM -> hint stage with a coherent English sales objection,
// using the exact prompt format TranscriptState produces and the exact request
// body LlamaClient sends. Confirms a visible hint is generated.
const SYSTEM_PROMPT = `You are a live sales-call copilot. You see a running transcript of a call.
Output ONE hint of at most 8 words telling the seller what to say or ask next.
No preamble, no explanation, no quotes. Just the hint.
Match the language of the transcript.
If nothing useful applies, output exactly: -
`
const STATIC_CONTEXT = `<context>
Bespokesoft: software house. AI, ERP/CRM, Open Mercato.
</context>`

function renderPrompt(themLine) {
  return `${SYSTEM_PROMPT}\n\n${STATIC_CONTEXT}\n\n<transcript>\nThem: ${themLine}\n</transcript>\n\n<hint>`
}

async function hint(themLine) {
  const res = await fetch('http://127.0.0.1:8080/completion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: renderPrompt(themLine),
      stream: false,
      cache_prompt: true,
      id_slot: 0,
      n_predict: 24,
      temperature: 0.3,
      top_p: 0.9,
      stop: ['\n', '</hint>'],
    }),
  })
  const j = await res.json()
  return (j.content ?? '').trim()
}

const objections = [
  'this is way too expensive for our budget right now',
  'we already have a supplier we are happy with',
  'I need to talk to my team before deciding',
  'just send me the offer and I will look at it',
]

for (const o of objections) {
  console.log(`THEM: "${o}"`)
  console.log(`  HINT: "${await hint(o)}"\n`)
}
