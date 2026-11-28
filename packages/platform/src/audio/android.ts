import { native } from '../native';
import {
  AudioModule,
  createAudioPlayer,
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioRecorder,
} from 'expo-audio';
import { File } from 'expo-file-system';
import type { AudioService, PermissionState, SpeechLang } from '../contracts';

let speaking = 0;
let clipModeReady = false;
let recorder: AudioRecorder | null = null;
let recordTimer: ReturnType<typeof setTimeout> | null = null;
let recordResolve: ((v: { uri: string; durationMs: number; bytes: number }) => void) | null = null;
let recordStartedAt = 0;
let recordStarting = false;
let stopWanted = false;

/** Navigation voice ducks other apps (music/podcasts); emote clips mix in quietly underneath. */
async function voiceMode(): Promise<void> {
  clipModeReady = false;
  await setAudioModeAsync({ interruptionMode: 'duckOthers', shouldPlayInBackground: true, playsInSilentMode: true });
}

/** Queue every segment on the system TTS (per-segment voice, QUEUE_ADD); other apps are ducked meanwhile. */
async function speakSegments(segments: readonly { text: string; lang: SpeechLang }[]): Promise<void> {
  if (segments.length === 0) return;
  speaking++;
  try {
    await voiceMode();
    await native.ttsSpeak(segments.map((s) => ({ lang: s.lang, text: s.text })));
  } finally {
    speaking = Math.max(0, speaking - 1);
  }
}

const perm = (granted: boolean, canAsk: boolean): PermissionState => (granted ? 'granted' : canAsk ? 'undetermined' : 'denied');

async function finishRecording(): Promise<void> {
  const r = recorder;
  const resolve = recordResolve;
  recorder = null;
  recordResolve = null;
  if (recordTimer) clearTimeout(recordTimer);
  recordTimer = null;
  if (!r || !resolve) return;
  await r.stop();
  const uri = r.uri ?? '';
  const bytes = uri ? (new File(uri).size ?? 0) : 0;
  resolve({ uri, durationMs: Date.now() - recordStartedAt, bytes });
}

export const androidAudio: AudioService = {
  speak: (text, lang) => speakSegments([{ text, lang }]),
  speakSegments,
  isSpeaking: () => speaking > 0 || native.ttsIsSpeaking(),
  voiceStatus: (lang) => native.ttsVoiceStatus(lang),
  installVoice: async () => native.ttsInstallVoice(),
  voiceName: (lang) => native.ttsVoiceName(lang),
  voices: () => native.ttsVoices(),
  playClip: async (uri, opts) => {
    const vol = Math.min(1, Math.max(0.05, opts.volume ?? (opts.duckUnderVoice ? 0.35 : 1)));
    const rate = opts.rate ? Math.min(2, Math.max(0.5, opts.rate)) : 1;
    // Prefer native SoundPool (24-voice polyphonic PCM mixer: overlapping emotes stack additively and never cut each other out).
    if (typeof native.soundPlay === 'function') {
      try {
        if (await native.soundPlay(uri, vol, rate, opts.duckUnderVoice)) return;
      } catch {
        // Fall through to expo-audio player (e.g. remote URI or pre-rebuild binary).
      }
    }
    // Configure mixWithOthers once so starting overlapping clips never triggers audio-focus re-negotiation that pauses active clips.
    if (!clipModeReady && speaking === 0 && !recorder && !recordStarting) {
      clipModeReady = true;
      await setAudioModeAsync({ interruptionMode: 'mixWithOthers', playsInSilentMode: true, shouldPlayInBackground: true }).catch(() => {
        clipModeReady = false;
      });
    }
    const player = createAudioPlayer(uri);
    player.volume = vol;
    if (rate !== 1) {
      player.shouldCorrectPitch = false;
      player.setPlaybackRate(rate);
    }
    await new Promise<void>((resolve) => {
      let done = false;
      let safety: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (safety) clearTimeout(safety);
        sub.remove();
        try {
          player.remove();
        } catch {
          // already released
        }
        resolve();
      };
      const sub = player.addListener('playbackStatusUpdate', (s) => {
        if (s.didJustFinish) finish();
      });
      player.play();
      // Safety net: clips are ≤ 5 s.
      safety = setTimeout(finish, 6500);
    });
  },
  record: async (maxMs, onStart) => {
    if (recorder) await finishRecording();
    clipModeReady = false;
    recordStarting = true;
    stopWanted = false;
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, interruptionMode: 'doNotMix' });
      const preset = RecordingPresets.LOW_QUALITY;
      const r = new AudioModule.AudioRecorder({ ...preset, ...preset.android, numberOfChannels: 1 }) as AudioRecorder;
      await r.prepareToRecordAsync();
      // Released before the microphone was ready: nothing to record (the old code kept recording the full limit).
      if (stopWanted) {
        stopWanted = false;
        await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        return { uri: '', durationMs: 0, bytes: 0 };
      }
      recorder = r;
      recordStartedAt = Date.now();
      r.record();
    } finally {
      recordStarting = false;
    }
    onStart?.();
    return new Promise((resolve) => {
      recordResolve = resolve;
      recordTimer = setTimeout(() => void finishRecording(), maxMs);
    });
  },
  stopRecording: async () => {
    if (recordStarting && !recorder) stopWanted = true;
    await finishRecording();
    await setAudioModeAsync({ allowsRecording: false });
  },
  micPermission: async () => {
    const p = await getRecordingPermissionsAsync();
    return perm(p.granted, p.canAskAgain);
  },
  requestMic: async () => {
    const p = await requestRecordingPermissionsAsync();
    return perm(p.granted, p.canAskAgain);
  },
};
