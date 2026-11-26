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
let recorder: AudioRecorder | null = null;
let recordTimer: ReturnType<typeof setTimeout> | null = null;
let recordResolve: ((v: { uri: string; durationMs: number; bytes: number }) => void) | null = null;
let recordStartedAt = 0;

/** Navigation voice ducks other apps (music/podcasts); emote clips mix in quietly underneath. */
async function voiceMode(): Promise<void> {
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
    await setAudioModeAsync({ interruptionMode: opts.duckUnderVoice ? 'mixWithOthers' : 'duckOthers', playsInSilentMode: true, shouldPlayInBackground: true });
    const player = createAudioPlayer(uri);
    player.volume = opts.volume ?? (opts.duckUnderVoice ? 0.35 : 1);
    if (opts.rate && opts.rate !== 1) {
      player.shouldCorrectPitch = false;
      player.setPlaybackRate(Math.min(2, Math.max(0.5, opts.rate)));
    }
    await new Promise<void>((resolve) => {
      const sub = player.addListener('playbackStatusUpdate', (s) => {
        if (s.didJustFinish) {
          sub.remove();
          player.remove();
          resolve();
        }
      });
      player.play();
      // Safety net: clips are ≤ 5 s.
      setTimeout(() => {
        sub.remove();
        try {
          player.remove();
        } catch {
          // already released
        }
        resolve();
      }, 6500);
    });
  },
  record: async (maxMs) => {
    if (recorder) await finishRecording();
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, interruptionMode: 'doNotMix' });
    const preset = RecordingPresets.LOW_QUALITY;
    const r = new AudioModule.AudioRecorder({ ...preset, ...preset.android, numberOfChannels: 1 }) as AudioRecorder;
    await r.prepareToRecordAsync();
    recorder = r;
    recordStartedAt = Date.now();
    r.record();
    return new Promise((resolve) => {
      recordResolve = resolve;
      recordTimer = setTimeout(() => void finishRecording(), maxMs);
    });
  },
  stopRecording: async () => {
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
