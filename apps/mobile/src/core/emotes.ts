import { Asset } from 'expo-asset';
import { File, Paths } from 'expo-file-system';
import { AppState } from 'react-native';
import { platform } from '@crewmap/platform';
import { QuipService, fromUtf8, utf8, type QuipMeta, type ReceivedQuip, type SavedQuip } from '@crewmap/p2p';
import {
  DrivingEmoteLimiter,
  EMOTE_LIMITS,
  validateEmote,
  type EmoteMessage,
  EMOTE_EMOJI,
  type EmotePreset,
} from '@crewmap/shared/emotes';
import { lang, t } from '@crewmap/shared/i18n';
import { audioLayers, EDGE_AUDIO, planEdgeBurst, seedOf } from '@crewmap/shared/emoteBurst';
import { notifIdFor } from '@crewmap/shared/messaging';
import {
  EMOTE_COMBO,
  aggregateEmotes,
  comboPlan,
  type ComboGroup,
  type PendingEmote,
  type Streak,
  nextStreak,
  streakPop,
} from '@crewmap/shared/emoteCombo';
import type { Crews } from './crews';
import { kvGet, kvSet } from './db';
import { attachFriendLog, isMuted } from './friendPrefs';
import { notifyMode, emotePopup } from '../ui/drive/driveUx';
import { friendContextNow } from './friendContext';
import { notify } from './notify';
import { blipFor, notifyEmoteCollapsed } from './msgNotify';
import { rideMuted, watchRideEnd } from './rideMutes';
import { useApp } from './store';
import { addReceived, blobUri, blobsOf, quipStore, refreshQuips } from './quips';
import { STINGS, VOICE_LINES, type Sting } from './emoteVoiceAssets';

/** Non-verbal layer under each preset's announcer line. */
const PRESET_STING: Record<EmotePreset, Sting> = {
  getMeFood: 'pop',
  areWeThereYet: 'whoosh',
  whereAreYou: 'pop',
  hurryUp: 'whoosh',
  callMe: 'pop',
  honkHonk: 'horn',
  onMyWay: 'whoosh',
  missYou: 'pop',
};

async function assetUri(mod: number): Promise<string> {
  const a = Asset.fromModule(mod);
  if (!a.localUri) await a.downloadAsync();
  return a.localUri ?? a.uri;
}

interface OutboxEntry {
  to: string;
  msg: EmoteMessage;
  t: number;
}

export class Emotes {
  private readonly limiter = new DrivingEmoteLimiter();
  /** Sender-side: last emote sent to each friend (respect their driving limit before sending). */
  private readonly sentAt = new Map<string, number>();
  private offs: (() => void)[] = [];
  /** Sender-side outbox: emotes not yet acknowledged, kept 72 h and re-sent when we are back online. */
  private outbox: OutboxEntry[] = [];
  private outboxLoaded = false;
  private readonly inflight = new Map<string, string>();
  private readonly hooked = new WeakSet<object>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDelayMs = 30_000;
  /** Receiver-side: catch-up emotes collected until the replay goes quiet, then played as one combo per group. */
  private collected: PendingEmote[] = [];
  private readonly seenKeys = new Set<string>();
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private notifiedBg = false;
  private streak: Streak | null = null;
  private finaleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Combos held back while driving; played once stopped. */
  private deferred: ComboGroup[] = [];
  private quips: QuipService | null = null;

  constructor(private readonly net: Crews) {}

  start(): void {
    const r = this.net.router;
    if (!r) return;
    attachFriendLog(r);
    this.quips?.stop();
    this.quips = new QuipService({
      bus: r,
      store: quipStore,
      members: () => Object.keys(useApp.getState().allFriends),
      protocolOf: (p) => useApp.getState().allFriends[p]?.presence ?? null,
      onQuip: (q) => void this.receiveQuip(q),
      legacyEmote: async (peer, c) => {
        await this.send(peer, { preset: 'custom', clip: c.base64, clipMs: c.ms, ...(c.label ? { label: c.label } : {}) });
      },
    });
    this.quips.start();
    void refreshQuips();
    this.inflight.clear();
    if (!this.hooked.has(r)) {
      this.hooked.add(r);
      r.onDelivery((d) => {
        if (d.kind !== 'emote') return;
        const k = this.inflight.get(d.id);
        if (!k) return;
        this.inflight.delete(d.id);
        if (d.ok) void this.dropOutbox(k);
        else this.scheduleFlush();
      });
    }
    void this.flushOutbox();
    const appSub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        void this.flushOutbox();
        this.scheduleCombo(0);
      }
    });
    const unsub = useApp.subscribe((s, prev) => {
      const was = prev.driving || prev.nav?.active === true;
      const isNow = s.driving || s.nav?.active === true;
      if (was && !isNow && this.deferred.length) this.playDeferred();
      if (!prev.ready && s.ready) this.scheduleCombo(0);
    });
    this.offs.push(
      () => appSub.remove(),
      unsub,
      watchRideEnd(),
      r.on(
        'emote',
        (m) => void this.receive(m.sender, m.id, JSON.parse(fromUtf8(m.payload)) as EmoteMessage, m.sentAt),
      ),
      r.on('arrival', (m) => {
        const a = JSON.parse(fromUtf8(m.payload)) as {
          placeId?: string;
          placeName: string;
          kind: 'arrive' | 'leave' | 'drivingHome';
        };
        const name = this.net.doc.profile(m.sender)?.name ?? '';
        const title =
          a.kind === 'arrive'
            ? t('notif.arrived', { name, place: a.placeName })
            : a.kind === 'leave'
              ? t('notif.left', { name, place: a.placeName })
              : t('notif.drivingHome', { name });
        const { ctx, next } = friendContextNow();
        const mode = notifyMode('arrival', ctx, next);
        if (!isMuted(m.sender) && mode !== 'skip')
          void notify(title, '', {
            channel: 'circle',
            silent: mode === 'silent',
            data: {
              type: a.kind === 'arrive' ? 'arrival' : a.kind === 'leave' ? 'departure' : 'moment',
              friendId: m.sender,
              ...(a.placeId ? { placeId: a.placeId } : {}),
              ...(a.placeName ? { placeName: a.placeName } : {}),
            },
          });
      }),
    );
  }

  stop(): void {
    this.quips?.stop();
    for (const o of this.offs) o();
    this.offs = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.flushTimer = this.quietTimer = null;
  }

  /** Whether the friend is driving right now (from their presence). */
  isDriving(friendId: string): boolean {
    const p = useApp.getState().allFriends[friendId]?.presence;
    return !!p && p.act === 'automotive' && Date.now() - p.t < 5 * 60_000;
  }

  /** ms until we may send to a driving friend again (0 = now). */
  cooldown(friendId: string): number {
    if (!this.isDriving(friendId)) return 0;
    const last = this.sentAt.get(friendId);
    return last === undefined ? 0 : Math.max(0, EMOTE_LIMITS.drivingIntervalMs - (Date.now() - last));
  }

  async send(to: string, msg: EmoteMessage): Promise<boolean> {
    if (validateEmote(msg) || this.cooldown(to) > 0 || !this.net.router) return false;
    this.sentAt.set(to, Date.now());
    const k = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const full: EmoteMessage = { ...msg, k };
    await this.loadOutbox();
    this.outbox.push({ to, msg: full, t: Date.now() });
    await this.saveOutbox();
    await this.transmitEmote(to, full, k);
    platform.haptics.play('bounce');
    return true;
  }

  private async transmitEmote(to: string, msg: EmoteMessage, k: string): Promise<void> {
    const r = this.net.router;
    if (!r || [...this.inflight.values()].includes(k)) return;
    const id = await r.sendTo(to, 'emote', utf8(JSON.stringify(msg)));
    this.inflight.set(id, k);
  }

  private async loadOutbox(): Promise<void> {
    if (this.outboxLoaded) return;
    this.outboxLoaded = true;
    const saved = await kvGet<OutboxEntry[]>('emoteOutbox', []);
    this.outbox = [...saved, ...this.outbox];
  }

  private saveOutbox(): Promise<void> {
    return kvSet('emoteOutbox', this.outbox);
  }

  private async dropOutbox(k: string): Promise<void> {
    this.outbox = this.outbox.filter((e) => e.msg.k !== k);
    await this.saveOutbox();
  }

  /** Re-send everything not yet acknowledged (relays keep it 72 h; the recipient dedupes by `k`). */
  async flushOutbox(): Promise<void> {
    await this.loadOutbox();
    const cutoff = Date.now() - EMOTE_COMBO.outboxMs;
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((e) => e.t > cutoff);
    if (this.outbox.length !== before) await this.saveOutbox();
    for (const e of this.outbox) if (e.msg.k) await this.transmitEmote(e.to, e.msg, e.msg.k);
    if (this.outbox.length) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushDelayMs = Math.min(this.flushDelayMs * 2, 10 * 60_000);
      void this.flushOutbox();
    }, this.flushDelayMs);
  }

  /** Send a saved quip to one friend or the whole crew ('crew'). Honours the driving cooldown and the crew policy. */
  async sendQuip(to: string, q: SavedQuip): Promise<'ok' | 'cooldown' | 'slow' | 'failed'> {
    if (!this.net.router || !this.quips) return 'failed';
    if (to !== 'crew' && this.cooldown(to) > 0) return 'cooldown';
    const blobs = await blobsOf(q);
    if (!blobs) return 'failed';
    const meta: QuipMeta = { by: q.by, ...(q.cap ? { cap: q.cap } : {}), ...(q.emoji ? { emoji: q.emoji } : {}), ...(q.a ? { a: q.a } : {}), ...(q.i ? { i: q.i } : {}) };
    const r = await this.quips.send(to, meta, blobs);
    if (!r.ok) return r.reason === 'rate limited' ? 'slow' : 'failed';
    if (to !== 'crew') this.sentAt.set(to, Date.now());
    platform.haptics.play('bounce');
    return 'ok';
  }

  /** A friend's quip with all blobs held: popup/sound under the emote driving policy, inbox for "Save to my quips". */
  private async receiveQuip(q: ReceivedQuip): Promise<void> {
    addReceived({ id: q.id, from: q.from, meta: q.meta, at: Date.now() });
    const s = useApp.getState();
    const driving = s.driving || s.nav?.active === true;
    const name = this.net.doc.profile(q.from)?.name ?? '';
    const label = q.meta.cap ?? q.meta.emoji ?? t('emote.custom');
    const fc = friendContextNow();
    if (AppState.currentState !== 'active') {
      const mode = notifyMode('emote', fc.ctx, fc.next);
      if (!isMuted(q.from) && !rideMuted(q.from) && mode !== 'skip')
        void notifyEmoteCollapsed({ from: q.from, name, preset: 'custom', emoji: q.meta.emoji ?? EMOTE_EMOJI.custom, label, silent: mode === 'silent' });
      return;
    }
    if (rideMuted(q.from)) return this.logMuted(q.from);
    if (Date.now() - q.sentAt > EMOTE_COMBO.freshMs || !this.limiter.allow(q.from, Date.now(), driving)) return;
    const clipUri = q.meta.a ? await blobUri(q.meta.a, true) : null;
    const imageUri = q.meta.i ? await blobUri(q.meta.i, false) : null;
    const shown = emotePopup(fc.ctx, fc.next, s.settings.drivingEmotePopups);
    if (!shown && (!driving || s.settings.drivingEmotePopups)) blipFor({ thread: q.from, from: q.from, name, kind: 'quip', viewing: false, muted: isMuted(q.from), overlayShown: false });
    if (shown) {
      useApp.getState().set({
        emotes: [
          ...useApp.getState().emotes,
          {
            id: `quip-${q.from}-${q.k}`,
            from: q.from,
            msg: { preset: 'custom', label },
            at: Date.now(),
            quip: { id: q.id, meta: q.meta, ...(imageUri ? { imageUri } : {}) },
            ...(clipUri ? { clipUri } : {}),
          },
        ],
      });
    }
    // Sound only when the emote policy allows it (always when stopped; ducked under nav voice while driving).
    if (clipUri && (!driving || (s.settings.drivingEmoteSound && s.settings.voice === 'on'))) void platform.audio.playClip(clipUri, { duckUnderVoice: driving });
    platform.haptics.play('bounce');
  }

  /** Record a custom clip (≤ 5 s, size-capped) → base64. */
  async recordClip(): Promise<{ clip: string; clipMs: number } | null> {
    if (
      (await platform.audio.micPermission()) !== 'granted' &&
      (await platform.audio.requestMic()) !== 'granted'
    )
      return null;
    const r = await platform.audio.record(EMOTE_LIMITS.maxClipMs);
    if (!r.uri || r.bytes > EMOTE_LIMITS.maxClipBytes) return null;
    const clip = await new File(r.uri).base64();
    return { clip, clipMs: Math.min(r.durationMs, EMOTE_LIMITS.maxClipMs) };
  }

  stopRecording(): Promise<void> {
    return platform.audio.stopRecording();
  }

  private async receive(from: string, id: string, msg: EmoteMessage, sentAt: number): Promise<void> {
    if (validateEmote(msg)) return;
    // Dedupe by the sender's key (re-sent copies), never by emote type: rapid repeats all count.
    const key = `${from}:${msg.k ?? id}`;
    if (this.seenKeys.has(key)) return;
    this.seenKeys.add(key);
    if (this.seenKeys.size > EMOTE_COMBO.seenCap) this.seenKeys.delete(this.seenKeys.values().next().value as string);
    // Live and in the foreground: play right away. Anything else (catch-up replay, background) is collected.
    if (Date.now() - sentAt > EMOTE_COMBO.freshMs || AppState.currentState !== 'active') {
      this.collected.push({
        id: key,
        from,
        preset: msg.preset,
        ...(msg.preset === 'custom' ? { label: msg.label ?? t('emote.custom') } : {}),
        sentAt,
      });
      this.scheduleCombo(EMOTE_COMBO.quietMs);
      return;
    }
    await this.playLive(from, id, msg);
  }

  private scheduleCombo(ms: number): void {
    if (!this.collected.length) return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.settleCollected();
    }, ms);
  }

  /** Replay went quiet: group, notify once per sender in the background, celebrate once foreground and booted. */
  private settleCollected(): void {
    if (!this.collected.length) return;
    const summary = aggregateEmotes(this.collected, Date.now());
    const fc = friendContextNow();
    if (AppState.currentState !== 'active') {
      if (this.notifiedBg) return;
      this.notifiedBg = true;
      for (const g of summary.groups) {
        const mode = notifyMode('emote', fc.ctx, fc.next);
        if (isMuted(g.from) || rideMuted(g.from) || mode === 'skip') continue;
        const name = this.net.doc.profile(g.from)?.name ?? '';
        // Same identifier as notifyEmoteCollapsed: the catch-up summary replaces that friend's live notification.
        void notify(t('notif.emoteMany', { name, count: String(g.count), emoji: EMOTE_EMOJI[g.preset] }), '', {
          channel: 'circle',
          silent: mode === 'silent',
          identifier: notifIdFor('emote', g.from, g.preset),
          data: { type: 'emote', friendId: g.from, preset: g.preset },
        });
      }
      return;
    }
    if (!useApp.getState().ready) return; // re-armed when the store becomes ready (no boot-splash blast)
    this.notifiedBg = false;
    this.collected = [];
    if (summary.stale.length) {
      const digest = { ...useApp.getState().emoteDigest };
      for (const st of summary.stale) {
        const prev = digest[st.from];
        digest[st.from] = { count: (prev?.count ?? 0) + st.count, latestAt: Math.max(prev?.latestAt ?? 0, st.latestAt) };
      }
      useApp.getState().set({ emoteDigest: digest });
    }
    for (const g of summary.groups) {
      if (rideMuted(g.from)) this.logMuted(g.from, g.count, g.latestAt);
      else void this.celebrate(g);
    }
  }

  /** Ride-muted emotes are not shown or played, only counted into the friend's emote digest. */
  private logMuted(from: string, count = 1, at = Date.now()): void {
    const digest = { ...useApp.getState().emoteDigest };
    const prev = digest[from];
    digest[from] = { count: (prev?.count ?? 0) + count, latestAt: Math.max(prev?.latestAt ?? 0, at) };
    useApp.getState().set({ emoteDigest: digest });
  }

  private comboItem(g: ComboGroup, count: number) {
    return {
      id: `combo-${g.from}-${g.preset}-${g.latestAt}`,
      from: g.from,
      msg: { preset: g.preset, ...(g.label ? { label: g.label } : {}) } as EmoteMessage,
      at: Date.now(),
      count,
    };
  }

  private async celebrate(g: ComboGroup): Promise<void> {
    const s = useApp.getState();
    const driving = s.driving || s.nav?.active === true;
    if (!driving) return this.playCombo(g);
    // Moving: a small pill only; the big combo waits until we stop.
    const fc = friendContextNow();
    if (g.count > 1) this.deferred.push(g);
    if (emotePopup(fc.ctx, fc.next, s.settings.drivingEmotePopups)) s.set({ emotes: [...useApp.getState().emotes, this.comboItem(g, 1)] });
    else if (s.settings.drivingEmotePopups) blipFor({ thread: g.from, from: g.from, name: this.net.doc.profile(g.from)?.name ?? '', kind: 'emote', viewing: false, muted: isMuted(g.from), overlayShown: false });
  }

  private playDeferred(): void {
    const list = this.deferred;
    this.deferred = [];
    for (const g of list) {
      if (rideMuted(g.from)) this.logMuted(g.from, g.count, g.latestAt);
      else void this.playCombo(g);
    }
  }

  private async playCombo(g: ComboGroup): Promise<void> {
    // Front of the queue: the overlay shows it now, in sync with the sound and haptics below.
    const item = this.comboItem(g, g.count);
    useApp.getState().set({ emotes: [item, ...useApp.getState().emotes] });
    const plan = comboPlan(g.count);
    plan.offsetsMs.forEach((off, i) => setTimeout(() => platform.haptics.play(i === plan.bursts - 1 ? 'success' : 'bounce'), off));
    if (g.preset === 'custom') return;
    // Announcer line first, then escalating stings under the cascade (same planner as the overlay), cheer finale.
    const screen = { w: 400, h: 800 };
    const layers = audioLayers(planEdgeBurst({ screen, count: g.count, driving: false, occupied: [], seed: seedOf(item.id) }), g.count);
    void this.voice(g.preset).then((u) => {
      if (u) void platform.audio.playClip(u, { duckUnderVoice: false });
    });
    const sting = await assetUri(STINGS[PRESET_STING[g.preset]]);
    for (const l of layers) setTimeout(() => void platform.audio.playClip(sting, { duckUnderVoice: false, volume: l.volume, rate: l.rate }), l.delayMs + 250);
    if (g.count >= 3) {
      const cheer = await assetUri(STINGS.cheer);
      setTimeout(() => void platform.audio.playClip(cheer, { duckUnderVoice: false, volume: 0.6 }), plan.durationMs - 600);
    }
  }

  /** Rapid repeats from one sender grow the existing popup into a running combo. True when it handled this one. */
  private async liveStreak(from: string, id: string, msg: EmoteMessage): Promise<boolean> {
    const st = nextStreak(this.streak, from, msg.preset, Date.now(), id);
    this.streak = st;
    if (this.finaleTimer) clearTimeout(this.finaleTimer);
    this.finaleTimer = setTimeout(() => {
      // Quiet again: finale for a streak worth celebrating.
      if (this.streak?.id === st.id && st.count >= 3) {
        platform.haptics.play('success');
        void assetUri(STINGS.cheer).then((u) => platform.audio.playClip(u, { duckUnderVoice: false, volume: 0.6 }));
      }
      this.finaleTimer = null;
    }, EMOTE_COMBO.liveQuietMs);
    if (!st.continued || msg.preset === 'custom') return false;
    const pop = streakPop(st.count);
    const cur = useApp.getState().emotes;
    const i = cur.findIndex((e) => e.id === st.id);
    if (i < 0) return false;
    {
      const next = cur.slice();
      next[i] = { ...cur[i]!, count: st.count, live: true, at: Date.now() };
      useApp.getState().set({ emotes: next });
    }
    platform.haptics.play('bounce');
    if (pop.sound) {
      // Each repeat: the preset's sting, a little louder and higher (capped); the voice again every 4th.
      const rate = Math.min(EDGE_AUDIO.maxRate, 1 + (st.count - 1) * EDGE_AUDIO.rateStep);
      const uri = st.count % 4 === 0 ? await this.voice(msg.preset) : await assetUri(STINGS[PRESET_STING[msg.preset]]);
      if (uri) void platform.audio.playClip(uri, { duckUnderVoice: false, volume: pop.volume, rate });
    }
    return true;
  }

  private async playLive(from: string, id: string, msg: EmoteMessage): Promise<void> {
    const s = useApp.getState();
    const driving = s.driving || s.nav?.active === true;
    const fc = friendContextNow();
    const name = this.net.doc.profile(from)?.name ?? '';
    const label = msg.preset === 'custom' ? (msg.label ?? t('emote.custom')) : t(`emote.${msg.preset}`);
    if (rideMuted(from)) {
      this.logMuted(from);
      return;
    }
    if (!this.limiter.allow(from, Date.now(), driving)) return;
    if (!driving && AppState.currentState === 'active' && (await this.liveStreak(from, id, msg))) return;
    let clipUri: string | undefined;
    if (msg.preset === 'custom' && msg.clip) {
      const f = new File(Paths.cache, `emote-${id.replace(/[^a-z0-9]/gi, '')}.m4a`);
      f.create({ overwrite: true });
      f.write(msg.clip, { encoding: 'base64' });
      clipUri = f.uri;
    }
    const showPopup = emotePopup(fc.ctx, fc.next, s.settings.drivingEmotePopups);
    const playSound = !driving || (s.settings.drivingEmoteSound && s.settings.voice === 'on');
    if (showPopup) {
      useApp
        .getState()
        .set({
          emotes: [
            ...useApp.getState().emotes,
            { id, from, msg, at: Date.now(), ...(clipUri ? { clipUri } : {}) },
          ],
        });
    } else if (AppState.currentState === 'active' && (!driving || s.settings.drivingEmotePopups)) {
      blipFor({ thread: from, from, name, kind: 'emote', viewing: false, muted: isMuted(from), overlayShown: false });
    }
    if (playSound) {
      // While driving: the announcer line only, ducked under navigation voice, never interrupting it.
      const uri = clipUri ?? (msg.preset !== 'custom' ? await this.voice(msg.preset) : null);
      if (uri) void platform.audio.playClip(uri, { duckUnderVoice: driving });
      if (!driving && !clipUri && msg.preset !== 'custom') {
        const sting = await assetUri(STINGS[PRESET_STING[msg.preset]]);
        void platform.audio.playClip(sting, { duckUnderVoice: false, volume: 0.45 });
      }
    }
    if (AppState.currentState !== 'active') {
      const mode = notifyMode('emote', fc.ctx, fc.next);
      if (!isMuted(from) && mode !== 'skip')
        void notifyEmoteCollapsed({ from, name, preset: msg.preset, emoji: EMOTE_EMOJI[msg.preset], label, silent: mode === 'silent' });
    }
  }

  /** One of the preset's Crew Radio announcer lines in the app language, never the same one twice in a row. */
  private lastVoice = new Map<EmotePreset, number>();
  private async voice(p: EmotePreset): Promise<string | null> {
    const list = VOICE_LINES[lang()][p];
    if (!list.length) return null;
    const prev = this.lastVoice.get(p) ?? -1;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === prev) i = (i + 1) % list.length;
    this.lastVoice.set(p, i);
    return assetUri(list[i]!);
  }
}
