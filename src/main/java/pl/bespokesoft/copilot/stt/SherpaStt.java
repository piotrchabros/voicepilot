package pl.bespokesoft.copilot.stt;

import com.k2fsa.sherpa.onnx.*;

/**
 * Streaming Zipformer transducer via sherpa-onnx. Truly incremental — emits
 * revised text every frame, no 30s window, no chunk-stitching hacks.
 *
 * This is the part where Whisper is the wrong tool and everyone finds out too late:
 * Whisper is a 30-second encoder-decoder. Every "streaming Whisper" wrapper is
 * re-running the encoder over an ever-growing buffer and calling the 1-5s result
 * real-time. It isn't. Don't start there.
 *
 * Model (multilingual, includes Polish — verify against your own recordings):
 *   https://github.com/k2-fsa/sherpa-onnx/releases  -> look for a streaming
 *   zipformer or parakeet model whose language list covers pl.
 *
 * NOTE: the Java binding surface moves. If these class names don't resolve,
 * check sherpa-onnx/java-api-examples for the current shape — the concepts
 * (recognizer -> stream -> acceptWaveform -> decode -> getResult) are stable
 * even when the names aren't.
 */
public final class SherpaStt implements SttEngine {

    private final OnlineRecognizer recognizer;
    private OnlineStream stream;

    public SherpaStt(String modelDir) {
        OnlineTransducerModelConfig transducer = OnlineTransducerModelConfig.builder()
                .setEncoder(modelDir + "/encoder.onnx")
                .setDecoder(modelDir + "/decoder.onnx")
                .setJoiner(modelDir + "/joiner.onnx")
                .build();

        OnlineModelConfig model = OnlineModelConfig.builder()
                .setTransducer(transducer)
                .setTokens(modelDir + "/tokens.txt")
                .setNumThreads(2)
                .build();

        OnlineRecognizerConfig config = OnlineRecognizerConfig.builder()
                .setOnlineModelConfig(model)
                .setDecodingMethod("greedy_search")
                // Let Silero own endpointing. Two components racing to decide when
                // the turn ended is a bug you'll spend a week not finding.
                .setEnableEndpoint(false)
                .build();

        this.recognizer = new OnlineRecognizer(config);
        this.stream = recognizer.createStream();
    }

    @Override public void accept(float[] frame) {
        stream.acceptWaveform(frame, 16000);
        while (recognizer.isReady(stream)) {
            recognizer.decode(stream);
        }
    }

    @Override public String interim() {
        return recognizer.getResult(stream).getText().trim();
    }

    @Override public String finish() {
        String text = interim();
        stream.release();
        stream = recognizer.createStream();
        return text;
    }

    @Override public void close() {
        stream.release();
        recognizer.release();
    }
}
