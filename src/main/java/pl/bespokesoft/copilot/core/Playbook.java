package pl.bespokesoft.copilot.core;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/**
 * The instant layer. Character-trigram cosine over your own objection list.
 *
 * This is deliberately dumb, and it should stay dumb until it demonstrably isn't
 * enough. It runs in ~1ms, it has no model to load, and for "which of my 40
 * known objections is this" it's honestly competitive with anything heavier.
 * When it stops being enough, swap nearest() for an ONNX embedding model
 * (multilingual-e5-small runs fine on ORT Java) — the interface doesn't change.
 *
 * Trigrams, not words, because Polish inflection will eat a bag-of-words matcher
 * alive: "drogo" / "drogie" / "za drogi" are three different tokens and the same
 * objection. Trigrams see straight through that.
 *
 * Format (playbook.tsv), one per line:
 *   trigger phrase <TAB> hint to display
 *   za drogo, nie mamy budżetu <TAB> Cena vs koszt zwłoki — zapytaj o koszt status quo
 */
public final class Playbook {

    private record Entry(String trigger, String hint, Map<String, Integer> grams, double norm) {}

    private final List<Entry> entries = new ArrayList<>();
    private static final double MIN_SCORE = 0.25; // below this, show nothing rather than noise

    public static Playbook load(Path tsv) throws IOException {
        Playbook p = new Playbook();
        for (String line : Files.readAllLines(tsv)) {
            if (line.isBlank() || line.startsWith("#")) continue;
            String[] parts = line.split("\t", 2);
            if (parts.length != 2) continue;
            Map<String, Integer> g = trigrams(parts[0]);
            p.entries.add(new Entry(parts[0], parts[1].trim(), g, norm(g)));
        }
        return p;
    }

    /** Empty-safe: an unmatched turn shows nothing, which beats showing garbage. */
    public Optional<String> nearest(String text) {
        Map<String, Integer> q = trigrams(text);
        double qn = norm(q);
        if (qn == 0) return Optional.empty();

        Entry best = null;
        double bestScore = MIN_SCORE;
        for (Entry e : entries) {
            double s = cosine(q, qn, e.grams(), e.norm());
            if (s > bestScore) { bestScore = s; best = e; }
        }
        return Optional.ofNullable(best).map(Entry::hint);
    }

    private static Map<String, Integer> trigrams(String s) {
        String n = " " + s.toLowerCase().replaceAll("[^\\p{L}\\p{Nd}]+", " ").trim() + " ";
        Map<String, Integer> m = new HashMap<>();
        for (int i = 0; i + 3 <= n.length(); i++) {
            m.merge(n.substring(i, i + 3), 1, Integer::sum);
        }
        return m;
    }

    private static double norm(Map<String, Integer> m) {
        double s = 0;
        for (int v : m.values()) s += (double) v * v;
        return Math.sqrt(s);
    }

    private static double cosine(Map<String, Integer> a, double an, Map<String, Integer> b, double bn) {
        if (an == 0 || bn == 0) return 0;
        // iterate the smaller side
        Map<String, Integer> small = a.size() <= b.size() ? a : b;
        Map<String, Integer> big = small == a ? b : a;
        double dot = 0;
        for (var e : small.entrySet()) {
            Integer o = big.get(e.getKey());
            if (o != null) dot += (double) e.getValue() * o;
        }
        return dot / (an * bn);
    }
}
