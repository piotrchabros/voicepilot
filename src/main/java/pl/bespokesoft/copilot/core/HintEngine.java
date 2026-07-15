package pl.bespokesoft.copilot.core;

import pl.bespokesoft.copilot.llm.LlamaClient;

import java.util.concurrent.*;
import java.util.function.Consumer;

/**
 * The actual idea. Everything else in this project is plumbing.
 *
 * You cannot make the serial path (VAD -> STT -> turn-end -> LLM -> render) fit
 * in 300ms. Nobody can. So stop measuring from "they stopped talking" and start
 * generating while they're STILL TALKING. By the time they stop, the hint has
 * been on screen for half a second.
 *
 * Two layers:
 *   1. Retrieval  — nearest playbook entry, ~10ms, always shows something
 *   2. Generation — local LLM, ~50ms TTFT, overwrites layer 1 when it lands
 *
 * The user never sees a spinner, because there is always an answer already there.
 *
 * The reason this is a LOCAL-only design: it throws away most of its work.
 * ~10 speculations per turn, 9 discarded. On a metered API that's a bill and a
 * rate limit. On your own GPU it's fan noise.
 */
public final class HintEngine {

    /** Debounce. Below ~150ms you thrash; above ~400ms you lose the head start. */
    private static final long DEBOUNCE_MS = 200;

    private final ScheduledExecutorService sched =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "hint-engine");
                t.setDaemon(true);
                return t;
            });

    private final LlamaClient llm;
    private final Playbook playbook;
    private final TranscriptState state;
    private final Consumer<Hint> sink;

    private ScheduledFuture<?> pending;
    private LlamaClient.Generation inFlight;
    private String lastPrompt = "";

    public record Hint(String text, Source source) {
        public enum Source { RETRIEVED, GENERATED }
    }

    public HintEngine(LlamaClient llm, Playbook playbook, TranscriptState state, Consumer<Hint> sink) {
        this.llm = llm;
        this.playbook = playbook;
        this.state = state;
        this.sink = sink;
    }

    /**
     * Call this on EVERY interim STT update — i.e. ~30x/second while they talk.
     * Yes, really. That's the point.
     */
    public void onTranscriptUpdate() {
        // Layer 1: instant. Synchronous, ~10ms, no excuses.
        String key = state.retrievalKey();
        if (key.length() > 12) {
            playbook.nearest(key).ifPresent(p -> sink.accept(new Hint(p, Hint.Source.RETRIEVED)));
        }

        // Layer 2: debounced speculation.
        if (pending != null) pending.cancel(false);
        pending = sched.schedule(this::speculate, DEBOUNCE_MS, TimeUnit.MILLISECONDS);
    }

    private void speculate() {
        String prompt = state.renderPrompt();

        // Interim transcripts revise themselves constantly; don't re-run on a no-op.
        if (prompt.equals(lastPrompt)) return;
        lastPrompt = prompt;

        // Kill the previous speculation. It was based on a transcript that no
        // longer exists. Letting it finish would race the new one to the UI and
        // you'd get flicker — or worse, a stale hint winning.
        if (inFlight != null) inFlight.cancel();

        StringBuilder acc = new StringBuilder();
        var gen = llm.streamHint(prompt, tok -> {
            acc.append(tok);
            sink.accept(new Hint(acc.toString().trim(), Hint.Source.GENERATED));
        });
        inFlight = gen;
    }

    /**
     * VAD fired TURN_END. Note what we DON'T do here: we don't kick off a
     * generation and wait. The hint is already up. This just settles the
     * transcript so the next speculation has clean history.
     */
    public void onTurnEnd(TranscriptState.Speaker who, String finalText) {
        state.settle(who, finalText);
    }

    public void shutdown() {
        if (inFlight != null) inFlight.cancel();
        sched.shutdownNow();
    }
}
