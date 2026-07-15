package pl.bespokesoft.copilot;

import javafx.application.Application;
import javafx.stage.Stage;
import pl.bespokesoft.copilot.audio.*;
import pl.bespokesoft.copilot.core.*;
import pl.bespokesoft.copilot.llm.LlamaClient;
import pl.bespokesoft.copilot.stt.*;
import pl.bespokesoft.copilot.ui.Overlay;

import java.nio.file.Path;

public final class Main extends Application {

    private static final String MODELS = System.getProperty("user.home") + "/models";

    private static final String SYSTEM_PROMPT = """
        You are a live sales-call copilot. You see a running transcript of a call.
        Output ONE hint of at most 8 words telling the seller what to say or ask next.
        No preamble, no explanation, no quotes. Just the hint.
        Match the language of the transcript.
        If nothing useful applies, output exactly: -
        """;

    private final Overlay overlay = new Overlay();
    private AudioCapture micLeg, farLeg;
    private HintEngine engine;

    @Override
    public void start(Stage stage) throws Exception {
        overlay.start(stage);

        Playbook playbook = Playbook.load(Path.of("playbook.tsv"));
        TranscriptState state = new TranscriptState(SYSTEM_PROMPT, renderPlaybook(), 12);

        LlamaClient llm = new LlamaClient("http://127.0.0.1:8080");
        // Prefill the immutable prefix once, at startup, so the first real turn
        // isn't the one that pays for it.
        llm.warm(SYSTEM_PROMPT);

        engine = new HintEngine(llm, playbook, state, overlay::show);

        // Two legs. Two VADs. Two STT streams. The device split IS the diarization.
        farLeg = leg("BlackHole", 2, TranscriptState.Speaker.THEM, state);
        micLeg = leg("MacBook", 1, TranscriptState.Speaker.ME, state);

        farLeg.start();
        micLeg.start();

        stage.setOnCloseRequest(e -> shutdown());
    }

    private AudioCapture leg(String device, int ch, TranscriptState.Speaker who, TranscriptState state)
            throws Exception {
        SileroVad vad = new SileroVad(MODELS + "/silero_vad.onnx");
        SttEngine stt = new SherpaStt(MODELS + "/zipformer-streaming");

        return new AudioCapture(device, ch, frame -> {
            try {
                SileroVad.Event ev = vad.accept(frame);
                switch (ev) {
                    case SILENCE -> { /* don't burn STT cycles on room tone */ }
                    case SPEECH_START, SPEECH -> {
                        stt.accept(frame);
                        state.live(who, stt.interim());
                        // Only speculate on THEIR speech. Hinting at yourself
                        // while you're mid-sentence is just distracting.
                        if (who == TranscriptState.Speaker.THEM) {
                            engine.onTranscriptUpdate();
                        }
                    }
                    case TURN_END -> {
                        stt.accept(frame);
                        engine.onTurnEnd(who, stt.finish());
                    }
                }
            } catch (Exception ex) {
                ex.printStackTrace();
            }
        });
    }

    private String renderPlaybook() {
        // Whatever static context you want cached forever: ICP, pricing, objections,
        // your differentiators. Costs nothing per turn — it's in the warm prefix.
        return "<context>\nBespokesoft: software house. AI, ERP/CRM, Open Mercato.\n</context>";
    }

    private void shutdown() {
        if (engine != null) engine.shutdown();
        if (micLeg != null) micLeg.close();
        if (farLeg != null) farLeg.close();
        javafx.application.Platform.exit();
        System.exit(0);
    }

    public static void main(String[] args) {
        if (args.length > 0 && args[0].equals("--list-devices")) {
            System.out.println("Input devices:" + AudioCapture.listInputs());
            return;
        }
        launch(args);
    }
}
