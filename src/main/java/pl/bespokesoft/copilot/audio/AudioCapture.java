package pl.bespokesoft.copilot.audio;

import javax.sound.sampled.*;
import java.util.Arrays;
import java.util.function.Consumer;

/**
 * Captures from a named macOS input device and emits 32ms frames of 16kHz mono float PCM.
 *
 * Two instances run in parallel:
 *   - one on the built-in mic       -> you
 *   - one on "BlackHole 2ch"        -> the far end of the call
 *
 * That split is free speaker diarization. Don't pay an STT vendor for it.
 *
 * Setup for the BlackHole leg (Audio MIDI Setup.app):
 *   1. Install BlackHole 2ch (brew install blackhole-2ch)
 *   2. Create a Multi-Output Device = BlackHole 2ch + your speakers
 *   3. Set that Multi-Output as the system output, so you still hear the call
 *   4. Point this class at "BlackHole 2ch" as an INPUT
 */
public final class AudioCapture implements AutoCloseable {

    public static final int TARGET_RATE = 16_000;
    /** 512 samples @16k = 32ms. Not arbitrary: it's exactly what Silero VAD v5 wants. */
    public static final int FRAME_SAMPLES = 512;
    public static final int FRAME_MS = FRAME_SAMPLES * 1000 / TARGET_RATE; // 32

    /** Capture at 48k because that's what BlackHole and most Mac devices actually want. */
    private static final float DEVICE_RATE = 48_000f;
    private static final int DECIMATION = (int) (DEVICE_RATE / TARGET_RATE); // 3

    private final String deviceName;
    private final int channels;
    private final Consumer<float[]> onFrame;
    private volatile boolean running;
    private Thread thread;
    private TargetDataLine line;

    public AudioCapture(String deviceName, int channels, Consumer<float[]> onFrame) {
        this.deviceName = deviceName;
        this.channels = channels;
        this.onFrame = onFrame;
    }

    public void start() throws LineUnavailableException {
        AudioFormat fmt = new AudioFormat(DEVICE_RATE, 16, channels, true, false);
        Mixer.Info target = findMixer(deviceName);
        if (target == null) {
            throw new LineUnavailableException(
                "No input device matching '" + deviceName + "'. Available: " + listInputs());
        }

        line = (TargetDataLine) AudioSystem.getMixer(target)
                .getLine(new DataLine.Info(TargetDataLine.class, fmt));

        // Small buffer = low latency. Anything above ~4 frames and you're
        // adding tens of ms for nothing. javax.sound will silently round this.
        int frameBytes = FRAME_SAMPLES * DECIMATION * channels * 2;
        line.open(fmt, frameBytes * 4);
        line.start();

        running = true;
        thread = new Thread(this::loop, "capture-" + deviceName);
        thread.setPriority(Thread.MAX_PRIORITY); // audio thread; don't let GC pauses win
        thread.setDaemon(true);
        thread.start();
    }

    private void loop() {
        int frameBytes = FRAME_SAMPLES * DECIMATION * channels * 2;
        byte[] buf = new byte[frameBytes];

        while (running) {
            int read = 0;
            while (read < frameBytes && running) {
                int n = line.read(buf, read, frameBytes - read);
                if (n <= 0) break;
                read += n;
            }
            if (read < frameBytes) continue;
            onFrame.accept(toMono16k(buf, channels));
        }
    }

    /**
     * 48k interleaved int16 -> 16k mono float32 in [-1, 1].
     *
     * Crude box-filter decimation: averages each group of 3 samples. Good enough
     * for speech, and the aliasing it lets through sits above 8kHz where the STT
     * model isn't listening anyway. Swap for a proper polyphase FIR if WER suffers.
     */
    private static float[] toMono16k(byte[] pcm, int channels) {
        float[] out = new float[FRAME_SAMPLES];
        for (int i = 0; i < FRAME_SAMPLES; i++) {
            float acc = 0;
            for (int d = 0; d < DECIMATION; d++) {
                int sampleIdx = (i * DECIMATION + d) * channels;
                float chAcc = 0;
                for (int c = 0; c < channels; c++) {
                    int b = (sampleIdx + c) * 2;
                    short s = (short) ((pcm[b] & 0xFF) | (pcm[b + 1] << 8)); // little-endian
                    chAcc += s / 32768f;
                }
                acc += chAcc / channels;
            }
            out[i] = acc / DECIMATION;
        }
        return out;
    }

    private static Mixer.Info findMixer(String nameFragment) {
        return Arrays.stream(AudioSystem.getMixerInfo())
                .filter(m -> m.getName().toLowerCase().contains(nameFragment.toLowerCase()))
                .filter(m -> AudioSystem.getMixer(m).getTargetLineInfo().length > 0)
                .findFirst().orElse(null);
    }

    public static String listInputs() {
        StringBuilder sb = new StringBuilder();
        for (Mixer.Info m : AudioSystem.getMixerInfo()) {
            if (AudioSystem.getMixer(m).getTargetLineInfo().length > 0) {
                sb.append("\n  - ").append(m.getName());
            }
        }
        return sb.toString();
    }

    @Override public void close() {
        running = false;
        if (line != null) { line.stop(); line.close(); }
    }
}
