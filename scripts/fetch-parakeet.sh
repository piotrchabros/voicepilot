#!/usr/bin/env bash
# Fetch the Parakeet-TDT 0.6b v3 int8 model (NVIDIA, 25 European languages
# including Polish) converted for sherpa-onnx. ~700MB download.
# Run:  bash scripts/fetch-parakeet.sh
set -euo pipefail

MODELS="$HOME/models"
DST="$MODELS/parakeet-tdt-0.6b-v3"
ARCHIVE="sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"

mkdir -p "$MODELS"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

echo "==> downloading ${ARCHIVE}.tar.bz2 (~700MB)"
curl -L --fail -O \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ARCHIVE}.tar.bz2"
tar xjf "${ARCHIVE}.tar.bz2"

mkdir -p "$DST"
cp "$ARCHIVE"/encoder.int8.onnx "$DST/encoder.onnx"
cp "$ARCHIVE"/decoder.int8.onnx "$DST/decoder.onnx"
cp "$ARCHIVE"/joiner.int8.onnx "$DST/joiner.onnx"
cp "$ARCHIVE"/tokens.txt "$DST/tokens.txt"

echo "==> Done: $DST"
ls -la "$DST"
