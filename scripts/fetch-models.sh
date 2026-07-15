#!/usr/bin/env bash
# Fetch the runtime models the copilot needs into ~/models:
#   - silero_vad.onnx           (Silero VAD v5)
#   - zipformer-streaming/      (English streaming zipformer: encoder/decoder/joiner/tokens)
#
# The GGUF (llama) model is handled separately (already cached via llama-server -hf).
# Run:  bash scripts/fetch-models.sh
set -euo pipefail

MODELS="$HOME/models"
mkdir -p "$MODELS"

echo "==> [1/2] Silero VAD v5 -> $MODELS/silero_vad.onnx"
curl -L --fail -o "$MODELS/silero_vad.onnx" \
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"

echo "==> [2/2] Streaming zipformer (English)"
ARCHIVE="sherpa-onnx-streaming-zipformer-en-2023-06-26"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
curl -L --fail -O \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ARCHIVE}.tar.bz2"
tar xjf "${ARCHIVE}.tar.bz2"

DST="$MODELS/zipformer-streaming"
mkdir -p "$DST"
# Pick the fp32 (non-int8) variants; the archive names carry an epoch/avg suffix.
cp "$(ls "$ARCHIVE"/encoder-*.onnx | grep -v int8 | head -1)" "$DST/encoder.onnx"
cp "$(ls "$ARCHIVE"/decoder-*.onnx | grep -v int8 | head -1)" "$DST/decoder.onnx"
cp "$(ls "$ARCHIVE"/joiner-*.onnx  | grep -v int8 | head -1)" "$DST/joiner.onnx"
cp "$ARCHIVE/tokens.txt" "$DST/tokens.txt"

echo "==> Done."
echo "silero:    $(ls -la "$MODELS/silero_vad.onnx" | awk '{print $5, $9}')"
echo "zipformer: $DST"
ls -la "$DST"
