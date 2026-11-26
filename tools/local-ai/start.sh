#!/usr/bin/env bash
# Start the local LLM (gpt-oss-20b via llama.cpp) ON DEMAND. Never auto-started (owner rule).
#   bash tools/local-ai/start.sh          # CPU only (7800X3D) — the 9070 XT keeps mining
#   bash tools/local-ai/start.sh --gpu    # Vulkan on the 9070 XT (pause mining first)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${LOCAL_AI_PORT:-8089}"
MODEL="$ROOT/.tools/models/gpt-oss-20b-MXFP4.gguf"
if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo "local AI already running on :$PORT"; exit 0; fi
[ -f "$MODEL" ] || { echo "model missing: $MODEL"; exit 1; }
NGL=0; [ "${1:-}" = "--gpu" ] && NGL=99
nohup "$ROOT/.tools/llama/llama-server.exe" -m "$MODEL" --host 127.0.0.1 --port "$PORT" -c 16384 -t 8 -ngl "$NGL" --jinja \
  > "$ROOT/.cache/local-ai.log" 2>&1 &
for i in $(seq 1 120); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { echo "local AI ready on :$PORT (gpu layers: $NGL)"; exit 0; }; sleep 2; done
echo "local AI did not start; see .cache/local-ai.log"; exit 1
