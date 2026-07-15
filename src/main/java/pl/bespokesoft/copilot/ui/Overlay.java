package pl.bespokesoft.copilot.ui;

import javafx.application.Platform;
import javafx.geometry.Insets;
import javafx.geometry.Rectangle2D;
import javafx.scene.Scene;
import javafx.scene.layout.*;
import javafx.scene.paint.Color;
import javafx.scene.text.*;
import javafx.stage.*;
import pl.bespokesoft.copilot.core.HintEngine.Hint;

/**
 * Borderless always-on-top hint window.
 *
 * The uncomfortable truth this window exists to confront: reading a hint costs
 * you 500-1500ms of attention. That is 3-5x your entire pipeline latency. You
 * can shave 40ms off TTFT all week and it buys you nothing if the hint is a
 * sentence, because the human is the bottleneck, not the GPU.
 *
 * So: three words. Big. One at a time. If you can't say it in three words, the
 * hint is wrong, not too short.
 *
 * NOT SOLVED HERE: hiding this from screen share. That needs
 * NSWindow.sharingType = .none, which JavaFX doesn't expose. You'd have to grab
 * the NSWindow pointer through JNA and it's as fragile as it sounds. When this
 * matters, this one file becomes a small Swift app talking to Java over a socket
 * — and that's the natural v2 seam anyway, because the Swift app can also do
 * ScreenCaptureKit capture and delete the BlackHole dependency at the same time.
 */
public final class Overlay {

    private Text hintText;
    private HBox root;
    private Stage stage;

    public void start(Stage stage) {
        this.stage = stage;

        hintText = new Text("");
        hintText.setFont(Font.font("SF Pro Display", FontWeight.SEMI_BOLD, 30));
        hintText.setFill(Color.WHITE);

        root = new HBox(hintText);
        root.setPadding(new Insets(18, 28, 18, 28));
        root.setBackground(new Background(new BackgroundFill(
                Color.rgb(12, 12, 14, 0.86), new CornerRadii(14), Insets.EMPTY)));

        StackPane wrap = new StackPane(root);
        wrap.setStyle("-fx-background-color: transparent;");

        Scene scene = new Scene(wrap, 900, 90);
        scene.setFill(Color.TRANSPARENT);

        stage.initStyle(StageStyle.TRANSPARENT);
        stage.setAlwaysOnTop(true);
        stage.setScene(scene);

        // Bottom-centre, above the dock. Out of the camera's eyeline.
        Rectangle2D vb = Screen.getPrimary().getVisualBounds();
        stage.setX(vb.getMinX() + (vb.getWidth() - 900) / 2);
        stage.setY(vb.getMaxY() - 190);

        stage.show();
    }

    /**
     * Called from the STT/engine threads at ~30Hz. Platform.runLater coalesces
     * naturally on the FX thread; don't add your own throttle until you measure
     * a problem.
     */
    public void show(Hint hint) {
        Platform.runLater(() -> {
            hintText.setText(hint.text());
            // Retrieved hints are a guess; generated ones earned it. Dim the guess
            // so your eye learns to trust the bright one without reading either.
            hintText.setFill(hint.source() == Hint.Source.GENERATED
                    ? Color.WHITE
                    : Color.rgb(255, 255, 255, 0.55));
        });
    }

    public void clear() {
        Platform.runLater(() -> hintText.setText(""));
    }
}
