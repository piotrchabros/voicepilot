package pl.bespokesoft.copilot.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Talks to a local llama-server over SSE. Localhost round-trip is ~1ms, so the
 * process boundary costs you nothing and buys you a supervisor, a stable ABI,
 * and the ability to restart the model without restarting your app.
 *
 * Launch it like this — every flag here is load-bearing:
 *
 *   llama-server \
 *     -m ~/models/Qwen3-4B-Instruct-Q4_K_M.gguf \
 *     --host 127.0.0.1 --port 8080 \
 *     --n-gpu-layers 99 \        # Metal. Without this you're on CPU and it's over.
 *     --parallel 1 \             # ONE slot. One slot = one KV cache = it stays warm.
 *     --ctx-size 8192 \
 *     --cache-reuse 256 \        # reuse the cached prefix instead of re-prefilling
 *     --no-warmup=false
 *
 * The whole game is `cache_prompt: true` + a pinned slot + an append-only prompt.
 * Get that right and TTFT is ~30-50ms because you only prefill the new tokens.
 * Get it wrong — mutate anything in the middle of the prompt — and you re-prefill
 * 4k tokens on every keystroke of speech and end up SLOWER than a cloud API.
 */
public final class LlamaClient {

    private static final ObjectMapper M = new ObjectMapper();

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2))
            .build();
    private final String base;

    public LlamaClient(String base) { this.base = base; }

    /**
     * Streams a hint. Returns a handle you can cancel — and you will cancel it,
     * constantly, because interim transcripts get revised and most speculations
     * are wrong. That's fine. Locally, a wasted generation costs electricity.
     */
    public Generation streamHint(String prompt, Consumer<String> onToken) {
        AtomicBoolean cancelled = new AtomicBoolean(false);

        Map<String, Object> body = Map.of(
                "prompt", prompt,
                "stream", true,
                "cache_prompt", true,   // <- the entire point
                "id_slot", 0,           // <- pin to the warm slot
                "n_predict", 24,        // hints are <=10 words; don't let it ramble
                "temperature", 0.3,
                "top_p", 0.9,
                "stop", java.util.List.of("\n", "</hint>")
        );

        HttpRequest req;
        try {
            req = HttpRequest.newBuilder(URI.create(base + "/completion"))
                    .header("Content-Type", "application/json")
                    .timeout(Duration.ofSeconds(10))
                    .POST(HttpRequest.BodyPublishers.ofString(M.writeValueAsString(body)))
                    .build();
        } catch (Exception e) {
            return Generation.failed(e);
        }

        CompletableFuture<HttpResponse<Void>> f = http.sendAsync(
                req, HttpResponse.BodyHandlers.fromLineSubscriber(
                        new SseSubscriber(cancelled, onToken)));

        return new Generation(f, cancelled);
    }

    /** Fire once at startup so the model is resident and the prefix is cached. */
    public void warm(String systemPrefix) {
        try {
            streamHint(systemPrefix, t -> {}).future().join();
        } catch (Exception ignored) { }
    }

    public record Generation(CompletableFuture<?> future, AtomicBoolean cancelled) {
        static Generation failed(Throwable t) {
            return new Generation(CompletableFuture.failedFuture(t), new AtomicBoolean(true));
        }
        public void cancel() {
            cancelled.set(true);
            future.cancel(true);
        }
        public boolean isCancelled() { return cancelled.get(); }
    }

    private static final class SseSubscriber implements Flow.Subscriber<String> {
        private final AtomicBoolean cancelled;
        private final Consumer<String> onToken;
        private Flow.Subscription sub;

        SseSubscriber(AtomicBoolean cancelled, Consumer<String> onToken) {
            this.cancelled = cancelled;
            this.onToken = onToken;
        }

        @Override public void onSubscribe(Flow.Subscription s) { (sub = s).request(1); }

        @Override public void onNext(String line) {
            if (cancelled.get()) { sub.cancel(); return; }
            if (line.startsWith("data: ")) {
                try {
                    JsonNode n = M.readTree(line.substring(6));
                    String tok = n.path("content").asText("");
                    if (!tok.isEmpty()) onToken.accept(tok);
                } catch (Exception ignored) { }
            }
            sub.request(1);
        }

        @Override public void onError(Throwable t) { }
        @Override public void onComplete() { }
    }
}
