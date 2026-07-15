package pl.bespokesoft.copilot.core;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Append-only conversation state.
 *
 * "Append-only" is not stylistic. llama.cpp's prefix cache only survives if
 * everything before the new tokens is byte-identical to last time. Insert a
 * timestamp in the middle, re-order the playbook, trim an old turn from the
 * front — and you've invalidated the cache, triggered a full 4k-token re-prefill,
 * and turned your 40ms TTFT into 800ms. The cache is a prefix cache. Respect the
 * prefix.
 *
 * Which is why the sliding window below is deliberately NOT a sliding window
 * during a call: we grow until we hit the ceiling, then reset once and eat one
 * slow turn, rather than shifting the prefix on every single turn and eating a
 * slow turn every time.
 */
public final class TranscriptState {

    public enum Speaker { ME, THEM }

    public record Turn(Speaker speaker, String text) {
        String render() {
            return (speaker == Speaker.ME ? "Me: " : "Them: ") + text + "\n";
        }
    }

    private final String systemPrompt;
    private final String playbook;
    private final Deque<Turn> settled = new ArrayDeque<>();
    private final int maxTurns;

    private Speaker liveSpeaker = Speaker.THEM;
    private String liveText = "";

    public TranscriptState(String systemPrompt, String playbook, int maxTurns) {
        this.systemPrompt = systemPrompt;
        this.playbook = playbook;
        this.maxTurns = maxTurns;
    }

    /** Interim STT update for the turn currently in progress. */
    public void live(Speaker who, String text) {
        this.liveSpeaker = who;
        this.liveText = text;
    }

    /** VAD said the turn ended. Promote it. */
    public void settle(Speaker who, String text) {
        if (text.isBlank()) { liveText = ""; return; }
        settled.addLast(new Turn(who, text));
        while (settled.size() > maxTurns) settled.removeFirst(); // one slow turn, rarely
        liveText = "";
    }

    public String liveText() { return liveText; }
    public Speaker liveSpeaker() { return liveSpeaker; }

    /**
     * Immutable prefix first, volatile tail last. This ordering is the whole
     * reason TTFT stays double-digit.
     */
    public String renderPrompt() {
        StringBuilder sb = new StringBuilder(2048);
        sb.append(systemPrompt).append("\n\n");     // never changes
        sb.append(playbook).append("\n\n");          // never changes
        sb.append("<transcript>\n");
        for (Turn t : settled) sb.append(t.render()); // grows at the end only
        if (!liveText.isBlank()) {
            sb.append(liveSpeaker == Speaker.ME ? "Me: " : "Them: ")
              .append(liveText).append("\n");
        }
        sb.append("</transcript>\n\n");
        sb.append("<hint>");
        return sb.toString();
    }

    /** Cheap retrieval key: what they're saying right now. */
    public String retrievalKey() {
        return liveSpeaker == Speaker.THEM ? liveText : "";
    }
}
