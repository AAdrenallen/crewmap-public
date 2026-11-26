# Asset credits

All shipped 3D assets (`apps/mobile/assets/models/*.glb`) are original and generated procedurally by
`tools/blender/build_assets.py`; no third-party models, textures or animations are included.

| Item | Use | Source | Licence |
| --- | --- | --- | --- |
| Blender 4.x | headless asset build (tool only; its output is ours) | https://www.blender.org | GPL-3.0 (tool) |
| glTF-Transform (`@gltf-transform/core`, `extensions`, `functions`) | `tools/blender/optimize.mjs`: dedup, weld, quantize (dev dependency, not shipped) | https://github.com/donmccurdy/glTF-Transform | MIT |

## Emote voice ("Crew Radio" announcer) and stings

`apps/mobile/assets/emotes/voice/<lang>/*.ogg` are original lines (`tools/voice/lines.json`, written for CrewMap; no
lines or audio from any game or real person) synthesised offline by `tools/voice/build.mjs`, then pitched down,
saturated, radio-EQ'd and given a short reverb. `apps/mobile/assets/emotes/sting/*.ogg` (horn, whoosh, pop, cheer)
are procedural (ffmpeg `aevalsrc`/`anoisesrc`). Mono Opus 20 kbps, ~160 KB in total.

| Item | Use | Source | Licence |
| --- | --- | --- | --- |
| Piper TTS 2023.11.14-2 (`piper_windows_amd64.zip`) | speech synthesis (tool only) | https://github.com/rhasspy/piper | MIT |
| Voice `en_US-norman-medium` | English lines | https://huggingface.co/rhasspy/piper-voices (dataset: LibriVox) | public domain dataset; model MIT (piper-voices) |
| Voice `fr_FR-gilles-low` | French lines | https://huggingface.co/rhasspy/piper-voices | CC0 dataset; model MIT |
| Voice `ru_RU-denis-medium` | Russian lines | https://huggingface.co/rhasspy/piper-voices (OHF-Voice voice-datasets) | CC0 dataset; model MIT |
| espeak-ng (bundled in the Piper zip) | phonemisation for Piper (tool only) | https://github.com/espeak-ng/espeak-ng | GPL-3.0 (tool) |
| ONNX Runtime (bundled in the Piper zip) | Piper inference (tool only) | https://github.com/microsoft/onnxruntime | MIT |
| FFmpeg (BtbN `win64-lgpl` build) | post-processing and Opus encoding (tool only) | https://github.com/BtbN/FFmpeg-Builds | LGPL-2.1 (tool) |
