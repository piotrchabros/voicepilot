package pl.bespokesoft.copilot.stt;

/**
 * Keep this interface between you and any vendor. You WILL swap engines —
 * Polish WER is where they all diverge and none of the published benchmarks
 * will tell you which one wins on your actual calls.
 */
public interface SttEngine extends AutoCloseable {

    /** Feed 32ms of 16kHz mono float PCM. */
    void accept(float[] frame);

    /** Current best guess for the in-progress turn. Revised constantly — never trust it as final. */
    String interim();

    /** Call on VAD TURN_END. Returns the settled text and resets the stream. */
    String finish();
}
