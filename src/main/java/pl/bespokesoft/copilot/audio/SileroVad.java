package pl.bespokesoft.copilot.audio;

import ai.onnxruntime.*;

import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.util.HashMap;
import java.util.Map;

/**
 * Silero VAD v5 on ONNX Runtime. ~1ms per 32ms frame on one CPU core.
 *
 * Model: https://github.com/snakers4/silero-vad -> src/silero_vad/data/silero_vad.onnx
 *
 * v5 signature (v4 differs — it had separate h/c inputs, so don't mix them up):
 *   in : input (1,512) float, state (2,1,128) float, sr (1,) int64
 *   out: output (1,1) float, stateN (2,1,128) float
 */
public final class SileroVad implements AutoCloseable {

    private final OrtEnvironment env;
    private final OrtSession session;
    private float[][][] state = new float[2][1][128];

    // Hysteresis. Speech is easy to enter, hard to leave — clipping the tail of a
    // word costs you more than a few frames of trailing silence.
    private static final float ENTER = 0.5f;
    private static final float EXIT = 0.35f;

    /**
     * How long silence must persist before we call the turn over.
     *
     * This single number dominates your whole latency budget — it is added, in
     * full, to every hint. 500ms is the safe default everyone ships and it is
     * why naive copilots feel a beat late. Push it to ~250ms and rely on
     * speculative generation to have the answer ready anyway; the worst case is
     * you show a hint mid-sentence, which is survivable, because the reader just
     * ignores it. Replace this entirely with a semantic turn model when you can.
     */
    private static final int HANGOVER_MS = 250;
    private static final int HANGOVER_FRAMES = HANGOVER_MS / AudioCapture.FRAME_MS;

    private boolean speaking = false;
    private int silentFrames = 0;

    public enum Event { SILENCE, SPEECH_START, SPEECH, TURN_END }

    public SileroVad(String modelPath) throws OrtException {
        this.env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        opts.setIntraOpNumThreads(1); // it's tiny; more threads is pure overhead
        this.session = env.createSession(modelPath, opts);
    }

    /** @param frame 512 samples of 16kHz mono float PCM */
    public Event accept(float[] frame) throws OrtException {
        float p = probability(frame);

        if (!speaking) {
            if (p >= ENTER) {
                speaking = true;
                silentFrames = 0;
                return Event.SPEECH_START;
            }
            return Event.SILENCE;
        }

        if (p >= EXIT) {
            silentFrames = 0;
            return Event.SPEECH;
        }

        if (++silentFrames >= HANGOVER_FRAMES) {
            speaking = false;
            silentFrames = 0;
            return Event.TURN_END;
        }
        return Event.SPEECH;
    }

    private float probability(float[] frame) throws OrtException {
        try (OnnxTensor input = OnnxTensor.createTensor(env, FloatBuffer.wrap(frame), new long[]{1, 512});
             OnnxTensor st = OnnxTensor.createTensor(env, state);
             OnnxTensor sr = OnnxTensor.createTensor(env, LongBuffer.wrap(new long[]{16000}), new long[]{1})) {

            Map<String, OnnxTensor> in = new HashMap<>();
            in.put("input", input);
            in.put("state", st);
            in.put("sr", sr);

            try (OrtSession.Result r = session.run(in)) {
                float p = ((float[][]) r.get(0).getValue())[0][0];
                state = (float[][][]) r.get(1).getValue(); // carry recurrent state forward
                return p;
            }
        }
    }

    public void reset() {
        state = new float[2][1][128];
        speaking = false;
        silentFrames = 0;
    }

    @Override public void close() throws OrtException { session.close(); }
}
