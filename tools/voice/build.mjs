// Builds the original "Crew Radio" announcer emote lines + non-verbal stings (see docs/ASSET-CREDITS.md).
// Piper TTS (MIT) with public-domain/CC0 voices → ffmpeg character chain (pitch down, saturation, radio EQ, short
// reverb) → mono Opus/OGG. Also writes apps/mobile/src/core/emoteVoiceAssets.ts (static requires for Metro).
// Usage: node tools/voice/build.mjs   (needs .tools/piper-dl, .tools/piper-voices, .tools/ffmpeg-dl)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const tools = join(root, '.tools');
const piper = join(tools, 'piper-dl/piper/piper.exe');
const ffDir = readdirSync(join(tools, 'ffmpeg-dl')).find((d) => statSync(join(tools, 'ffmpeg-dl', d)).isDirectory());
const ffmpeg = join(tools, 'ffmpeg-dl', ffDir, 'bin/ffmpeg.exe');
const work = join(root, '.cache/voice-build');
const out = join(root, 'apps/mobile/assets/emotes');
const lines = JSON.parse(readFileSync(join(root, 'tools/voice/lines.json'), 'utf8'));

// Voice per language: model, pitch factor (< 1 = deeper) and speaking speed (length_scale < 1 = faster).
const VOICES = {
  en: { model: 'en_US-norman-medium', pitch: 1.06, speed: 0.78 },
  fr: { model: 'fr_FR-gilles-low', pitch: 1.04, speed: 0.78 },
  ru: { model: 'ru_RU-denis-medium', pitch: 1.0, speed: 0.78 },
};
const MAX_S = 2;

rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'models'), { recursive: true });
rmSync(join(out, 'voice'), { recursive: true, force: true });
rmSync(join(out, 'sting'), { recursive: true, force: true });

// The 2023 piper.exe rejects multi-codepoint phoneme tokens some newer voices list (espeak never emits them): drop
// them from a working copy of the voice config.
function model(name) {
  const j = JSON.parse(readFileSync(join(tools, 'piper-voices', `${name}.onnx.json`), 'utf8'));
  for (const k of Object.keys(j.phoneme_id_map)) if ([...k].length > 1) delete j.phoneme_id_map[k];
  writeFileSync(join(work, 'models', `${name}.onnx.json`), JSON.stringify(j));
  return { onnx: join(tools, 'piper-voices', `${name}.onnx`), config: join(work, 'models', `${name}.onnx.json`), sr: j.audio.sample_rate };
}

const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const OPUS = ['-ac', '1', '-c:a', 'libopus', '-b:a', '20k', '-application', 'voip', '-ar', '24000', '-map_metadata', '-1'];

const manifest = {};
for (const [lang, v] of Object.entries(VOICES)) {
  const m = model(v.model);
  mkdirSync(join(out, 'voice', lang), { recursive: true });
  manifest[lang] = {};
  for (const [preset, list] of Object.entries(lines[lang])) {
    manifest[lang][preset] = [];
    list.forEach((text, i) => {
      const raw = join(work, `${lang}-${preset}-${i}.wav`);
      execFileSync(piper, ['-m', m.onnx, '-c', m.config, '-f', raw, '--length_scale', String(v.speed), '--sentence_silence', '0'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      const file = `${preset}-${i}.ogg`;
      // Character chain: trim silence → pitch down (asetrate) while keeping tempo → gritty saturation → radio band
      // (300 Hz–3.6 kHz, presence bump) → short slap reverb → loudness, hard 2 s cap.
      const trimmed = join(work, `${lang}-${preset}-${i}-trim.wav`);
      ff(['-i', raw, '-af', 'silenceremove=start_periods=1:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_threshold=-40dB,areverse', trimmed]);
      const dur = Number(execFileSync(ffmpeg.replace(/ffmpeg\.exe$/, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', trimmed]).toString());
      // Over-long lines are sped up (announcer patter) rather than cut, leaving room for the reverb tail.
      const pitch = v.pitch * (1 + (((i * 7 + preset.length) % 5) - 2) * 0.035); // per-line variation (lively, sing-song)
      const tempo = Math.max(1, dur / (MAX_S - 0.2)) / pitch;
      const chain = [
        `asetrate=${Math.round(m.sr * pitch)},aresample=${m.sr},atempo=${Math.min(2, tempo).toFixed(3)}`,
        'acompressor=threshold=-24dB:ratio=3:attack=5:release=80,volume=1.4',
        'highpass=f=200,lowpass=f=7000,equalizer=f=3200:t=q:w=1.0:g=4',
        'aecho=0.8:0.4:35:0.12',
        'loudnorm=I=-16:TP=-1.5:LRA=7',
        `atrim=0:${MAX_S},afade=t=out:st=${MAX_S - 0.08}:d=0.08`,
      ].join(',');
      ff(['-i', trimmed, '-af', chain, ...OPUS, join(out, 'voice', lang, file)]);
      manifest[lang][preset].push(`voice/${lang}/${file}`);
    });
  }
}

// Non-verbal stings (procedural, original): horn honk, whoosh, pop, crowd cheer.
mkdirSync(join(out, 'sting'), { recursive: true });
const STINGS = {
  // Two detuned square-ish tones (car horn chord), short double honk.
  horn: ['-f', 'lavfi', '-i', "aevalsrc='0.3*(sgn(sin(2*PI*370*t))+sgn(sin(2*PI*466*t)))*(lt(mod(t,0.26),0.2))':s=24000:d=0.5", '-af', 'lowpass=f=2500,afade=t=out:st=0.42:d=0.08'],
  // Band-passed noise sweeping up then fading.
  whoosh: ['-f', 'lavfi', '-i', 'anoisesrc=d=0.45:c=pink:r=24000:a=0.6', '-af', "bandpass=f=900:w=600,volume='min(1,t*5)':eval=frame,afade=t=out:st=0.2:d=0.25"],
  // Fast downward sine blip.
  pop: ['-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*(900-1600*t)*t)*exp(-t*28)':s=24000:d=0.18"],
  // Crowd-ish cheer: wide noise with a fast tremolo and a slow swell.
  cheer: ['-f', 'lavfi', '-i', 'anoisesrc=d=1.1:c=pink:r=24000:a=0.5', '-af', 'bandpass=f=1400:w=1800,tremolo=f=11:d=0.6,afade=t=in:d=0.25,afade=t=out:st=0.7:d=0.4'],
};
for (const [name, args] of Object.entries(STINGS)) {
  const i = args.indexOf('-af');
  const src = i < 0 ? args : args.slice(0, i);
  const af = [...(i < 0 ? [] : [args[i + 1]]), 'loudnorm=I=-18:TP=-2'].join(',');
  ff([...src, '-af', af, ...OPUS, join(out, 'sting', `${name}.ogg`)]);
}

const ts = [
  '// Generated by tools/voice/build.mjs: do not edit by hand.',
  "import type { Lang } from '@crewmap/shared/i18n';",
  "import type { EmotePreset } from '@crewmap/shared/emotes';",
  '',
  '/** Crew Radio announcer lines per language and preset (1-3 variants each). */',
  'export const VOICE_LINES: Record<Lang, Record<EmotePreset, number[]>> = {',
  ...Object.entries(manifest).flatMap(([lang, presets]) => [
    `  ${lang}: {`,
    ...Object.entries(presets).map(([p, files]) => `    ${p}: [${files.map((f) => `require('../../assets/emotes/${f}')`).join(', ')}],`),
    '  },',
  ]),
  '};',
  '',
  '/** Non-verbal layers under the voice. */',
  'export const STINGS = {',
  ...Object.keys(STINGS).map((s) => `  ${s}: require('../../assets/emotes/sting/${s}.ogg') as number,`),
  '} as const;',
  'export type Sting = keyof typeof STINGS;',
  '',
];
writeFileSync(join(root, 'apps/mobile/src/core/emoteVoiceAssets.ts'), ts.join('\n'));

let total = 0;
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : (total += statSync(join(d, f)).size)));
walk(join(out, 'voice'));
walk(join(out, 'sting'));
console.log(`voice + stings: ${(total / 1024).toFixed(1)} KB`);
