import { useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EMOTE_EMOJI, EMOTE_LIMITS, type EmoteMessage, type EmotePreset } from '@crewmap/shared/emotes';
import { EMOTE_SUGGEST, emoteStreakDays, orderGrid, rankFavourites, recentChips, suggestEmotes, type FriendNow } from '@crewmap/shared/emoteSuggest';
import { agoParts, formatCountdown, startOfDay, type FriendEvent } from '@crewmap/shared/friend';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { loadFriendLogs, logEmote, useFriendPrefs, type EmoteLogEntry } from '../../core/friendPrefs';
import { loadPins, togglePin, useEmotePins } from '../../core/emotePins';
import { muteForRide, setMuteAllForRide } from '../../core/rideMutes';
import { useApp } from '../../core/store';
import { Bouncy, Button, EmptyState, SectionLabel } from '../../ui/kit';
import { EmoteArt } from '../../ui/emotes/EmoteArt';
import { QuipSection } from '../../ui/emotes/QuipSection';
import { useNow } from '../../ui/friend/useNow';
import { font, palette, type, useTheme } from '../../ui/theme';
import { ScreenHeader } from '../../ui/screens-common/Layout';
import { Icon } from '../../ui/screens-common/Icon';

const NO_LOG: EmoteLogEntry[] = [];
const NO_EVENTS: FriendEvent[] = [];
const NO_PINS: string[] = [];
const CHIP_W = 132;
const HOME = /home|maison|дом/i;

/**
 * Emote wheel (also opened by tapping a friend's moving avatar). Custom clip: hold to record ≤ 5 s.
 * One vertical ScrollView is the sheet's only scroller (nestedScrollEnabled), so a drag anywhere scrolls the screen and
 * the formSheet expands instead of eating the gesture; rows inside scroll horizontally only.
 */
export default function EmotePicker() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const { width } = useWindowDimensions();
  const friend = useApp((s) => s.allFriends[id]);
  const name = friend?.profile.name ?? '';
  const mutedUser = useApp((s) => s.rideMutes.users.includes(id));
  const mutedAll = useApp((s) => s.rideMutes.all);
  const history = useFriendPrefs((s) => s.emotes[id] ?? NO_LOG);
  const events = useFriendPrefs((s) => s.events[id] ?? NO_EVENTS);
  const pins = useEmotePins((s) => s.pins[id] ?? NO_PINS);
  const [cooldown, setCooldown] = useState(() => engine.emotes.cooldown(id));
  const [recording, setRecording] = useState(false);
  const [leftMs, setLeftMs] = useState<number>(EMOTE_LIMITS.maxClipMs);
  const [failed, setFailed] = useState<EmoteMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [burst, setBurst] = useState<number>(1);
  const now = useNow(60_000);
  const pulse = useSharedValue(1);
  const press = useSharedValue(1);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value * press.value }] }));

  useEffect(() => {
    const timer = setInterval(() => setCooldown(engine.emotes.cooldown(id)), 1000);
    return () => clearInterval(timer);
  }, [id]);
  useEffect(() => {
    pulse.value = recording ? withRepeat(withTiming(1.05, { duration: 450 }), -1, true) : withTiming(1, { duration: 150 });
  }, [recording, pulse]);
  useEffect(() => {
    void loadFriendLogs(id).catch(() => undefined);
    void loadPins().catch(() => undefined);
  }, [id]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.back();
      return true;
    });
    return () => sub.remove();
  }, [router]);

  const driving = !!friend && engine.emotes.isDriving(id);
  const ctx = useMemo<FriendNow>(() => {
    const p = friend?.presence;
    const last = events[events.length - 1];
    const got = [...history].reverse().find((h) => !h.mine);
    return {
      driving,
      ...(p ? { battery: p.bat, charging: p.chg } : {}),
      moment: last ? { kind: last.kind, t: last.t, home: HOME.test(last.placeName) } : null,
      lastReceived: got ? { preset: got.preset, t: got.t } : null,
    };
  }, [friend?.presence, events, history, driving]);
  const suggested = useMemo(() => suggestEmotes(ctx, now), [ctx, now]);
  const favs = useMemo(() => rankFavourites(history, pins, now), [history, pins, now]);
  const grid = useMemo(() => orderGrid(favs), [favs]);
  const recent = useMemo(() => recentChips(history), [history]);
  const streak = useMemo(() => emoteStreakDays(history, now, startOfDay), [history, now]);

  const deliver = async (msg: EmoteMessage, times = 1) => {
    setBusy(true);
    try {
      let ok = true;
      for (let i = 0; i < times && ok; i++) {
        ok = await engine.emotes.send(id, msg);
        void logEmote(id, { preset: msg.preset, mine: true, t: Date.now(), ok }).catch(() => undefined);
      }
      setCooldown(engine.emotes.cooldown(id));
      setFailed(ok ? null : msg);
    } catch {
      setFailed(msg);
      void logEmote(id, { preset: msg.preset, mine: true, t: Date.now(), ok: false }).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  // A driving friend gets one at a time (their rate limit); a burst is 2–5 quick repeats otherwise.
  const send = (preset: EmotePreset) => void deliver({ preset }, driving ? 1 : burst);

  // Bouncy owns onPressIn/onPressOut for its spring, so the hold-to-record button uses a plain Pressable.
  const recordStart = async () => {
    press.value = withSpring(0.95);
    setRecording(true);
    setLeftMs(EMOTE_LIMITS.maxClipMs);
    let tick: ReturnType<typeof setInterval> | null = null;
    try {
      const clip = await engine.emotes.recordClip(() => {
        // The countdown starts when the microphone really does.
        const t0 = Date.now();
        tick = setInterval(() => setLeftMs(Math.max(0, EMOTE_LIMITS.maxClipMs - (Date.now() - t0))), 100);
      });
      if (clip) await deliver({ preset: 'custom', ...clip });
    } finally {
      if (tick) clearInterval(tick);
      setRecording(false);
    }
  };

  if (!friend) {
    return (
      <View style={{ flex: 1, backgroundColor: th.bg }}>
        <EmptyState testID="emote-gone" icon="person" title={t('friend.gone')} action={{ label: t('common.close'), onPress: () => router.back() }} />
      </View>
    );
  }

  const off = cooldown > 0 || busy;
  const label = (p: EmoteLogEntry['preset']) => (p === 'custom' ? t('emote.custom') : t(`emote.${p}`));
  // Four columns in portrait, more when wide (landscape / tablets), never below ~76 dp per cell.
  const cols = Math.max(4, Math.min(8, Math.floor((width - 32) / 86)));
  const cellW = `${100 / cols - 1.5}%` as const;
  return (
    <ScrollView
      testID="emote-scroll"
      style={{ flex: 1, backgroundColor: th.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 14 }}
      nestedScrollEnabled
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <ScreenHeader title={name} />
      {/* Ride mutes: last until the ride ends (shared/rideMutes). */}
      <View style={styles.mutes}>
        <MuteChip testID="emote-mute-user" on={mutedUser} label={t('emote.muteUser', { name })} onPress={() => muteForRide(id, !mutedUser)} />
        <MuteChip testID="emote-mute-all" on={mutedAll} label={t('emote.muteAll')} onPress={() => setMuteAllForRide(!mutedAll)} />
        {streak >= 2 && (
          <View testID="emote-streak" style={[styles.muteChip, { backgroundColor: th.cardAlt }]}>
            <Text style={[type.caption, font('bold'), { color: th.text }]} numberOfLines={1}>{`🔥 ${t('catchUp.streak', { count: String(streak) })}`}</Text>
          </View>
        )}
      </View>
      {cooldown > 0 && (
        <View testID="emote-cooldown" style={[styles.banner, { backgroundColor: th.cardAlt }]}>
          <Icon name="clock" color={th.textSoft} size={18} />
          <Text style={[type.body, font('bold'), { color: th.textSoft, fontVariant: ['tabular-nums'] }]}>{t('emote.wait', { time: formatCountdown(cooldown) })}</Text>
        </View>
      )}
      {failed && (
        <View testID="emote-failed" style={[styles.banner, { backgroundColor: th.card, borderColor: palette.danger, borderWidth: 1.5 }]}>
          <Icon name="alert" color={palette.danger} size={18} />
          <Text style={[type.body, font('bold'), { color: palette.danger, flex: 1 }]}>{t('emote.failed')}</Text>
          <Button kind="secondary" compact testID="emote-retry" label={t('common.retry')} onPress={() => void deliver(failed)} />
        </View>
      )}
      <SectionLabel>{driving ? t('emote.drivingSet') : t('emote.quick')}</SectionLabel>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} snapToInterval={CHIP_W + 8} decelerationRate="fast">
        {suggested.map((p) => (
          <Bouncy key={p} testID={`emote-quick-${p}`} accessibilityLabel={t(`emote.${p}`)} disabled={off} onPress={() => send(p)} style={[styles.chip, { backgroundColor: th.card, opacity: off ? 0.4 : 1 }]}>
            <Text style={styles.chipEmoji}>{EMOTE_EMOJI[p]}</Text>
            <Text style={[styles.chipLabel, { color: th.text }]} numberOfLines={2}>
              {t(`emote.${p}`)}
            </Text>
          </Bouncy>
        ))}
      </ScrollView>
      {!driving && (
        <View style={styles.bursts} accessibilityRole="radiogroup">
          {EMOTE_SUGGEST.bursts.map((n) => (
            <Pressable
              key={n}
              testID={`emote-burst-${n}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: burst === n }}
              onPress={() => setBurst(n)}
              style={[styles.burst, { backgroundColor: burst === n ? th.text : th.cardAlt }]}
            >
              <Text style={[type.caption, font('bold'), { color: burst === n ? th.bg : th.textSoft }]}>{`×${n}`}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.grid}>
        {grid.map((p, i) => {
          const pinned = pins.includes(p);
          return (
            <Animated.View key={p} entering={FadeInDown.delay(i * 20).duration(200)} style={{ width: cellW }}>
              <Bouncy
                testID={`emote-${p}`}
                accessibilityLabel={t(`emote.${p}`)}
                accessibilityHint={t('emote.pinHint')}
                disabled={off}
                onPress={() => send(p)}
                onLongPress={() => void togglePin(id, p)}
                style={[styles.cell, { opacity: off ? 0.4 : 1 }]}
              >
                <Text style={styles.emoji}>{EMOTE_EMOJI[p]}</Text>
                <Text style={[styles.label, { color: th.text }]} numberOfLines={2}>
                  {t(`emote.${p}`)}
                </Text>
                {(pinned || favs.includes(p)) && <View style={[styles.favDot, { backgroundColor: pinned ? palette.brand : th.textFaint }]} />}
              </Bouncy>
            </Animated.View>
          );
        })}
      </View>
      {recent.length > 0 && (
        <>
          <SectionLabel>{t('emote.recent')}</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} snapToInterval={CHIP_W + 8} decelerationRate="fast">
            {recent.map((h) => {
              const ago = agoParts(h.t, now);
              const resend = h.preset !== 'custom';
              return (
                <Bouncy
                  key={h.key}
                  testID="emote-history-item"
                  accessibilityLabel={`${h.mine ? t('emote.sentBy') : name} · ${label(h.preset)}`}
                  disabled={!resend || off}
                  onPress={() => resend && send(h.preset as EmotePreset)}
                  style={[styles.chip, { backgroundColor: th.card, borderColor: h.ok ? th.border : palette.danger, borderWidth: StyleSheet.hairlineWidth * 2, opacity: resend && off ? 0.5 : 1 }]}
                >
                  <Text style={styles.chipEmoji}>{`${EMOTE_EMOJI[h.preset]}${h.count > 1 ? ` ×${h.count}` : ''}`}</Text>
                  <Text style={[styles.chipLabel, { color: h.ok ? th.text : palette.danger }]} numberOfLines={1}>
                    {label(h.preset)}
                  </Text>
                  <Text style={[type.caption, { color: th.textSoft }]} numberOfLines={1}>
                    {`${h.mine ? t('emote.sentBy') : name} · ${t(`friend.ago.${ago.unit}`, { n: ago.n })}`}
                  </Text>
                </Bouncy>
              );
            })}
          </ScrollView>
        </>
      )}
      <QuipSection friendId={id} friendName={name} disabled={off} />
      <Animated.View style={pulseStyle}>
        <Pressable
          testID="emote-record"
          accessibilityRole="button"
          accessibilityLabel={t('emote.record')}
          disabled={off}
          onPressIn={() => void recordStart()}
          onPressOut={() => {
            press.value = withSpring(1);
            void engine.emotes.stopRecording();
          }}
          style={[styles.record, { backgroundColor: recording ? palette.danger : th.card, borderColor: recording ? palette.danger : th.border, opacity: off ? 0.4 : 1 }]}
        >
          <EmoteArt preset="custom" size={36} />
          <Text style={[styles.recLabel, { color: recording ? '#FFFFFF' : th.text }]}>{recording ? `${(leftMs / 1000).toFixed(1)} s` : t('emote.record')}</Text>
        </Pressable>
      </Animated.View>
    </ScrollView>
  );
}

function MuteChip({ on, label, onPress, testID }: { on: boolean; label: string; onPress: () => void; testID: string }) {
  const th = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={[styles.muteChip, { backgroundColor: on ? th.text : th.cardAlt }]}
    >
      <Icon name={on ? 'bellOff' : 'bell'} size={15} color={on ? th.bg : th.textSoft} />
      <Text style={[type.caption, font('bold'), { color: on ? th.bg : th.textSoft }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  mutes: { flexDirection: 'row', gap: 8 },
  muteChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, minHeight: 34, borderRadius: 17, flexShrink: 1 },
  row: { gap: 8, paddingRight: 16 },
  chip: { width: CHIP_W, minHeight: 92, borderRadius: 18, padding: 10, gap: 2, justifyContent: 'center' },
  chipEmoji: { fontSize: 26, lineHeight: 32 },
  chipLabel: { fontSize: 13, fontWeight: '700' },
  bursts: { flexDirection: 'row', gap: 8 },
  burst: { minWidth: 48, minHeight: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 18, columnGap: '1.5%' },
  // No tile box: the emoji + label and the grid spacing carry the grouping (owner: boxes looked too boxy).
  cell: { minHeight: 88, alignItems: 'center', justifyContent: 'center', padding: 4, gap: 4 },
  emoji: { fontSize: 40, lineHeight: 48 },
  label: { fontSize: 11.5, fontWeight: '700', textAlign: 'center' },
  favDot: { position: 'absolute', top: 2, right: 8, width: 8, height: 8, borderRadius: 4 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, minHeight: 48, borderRadius: 16 },
  record: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, borderRadius: 28, minHeight: 64, borderWidth: 1.5 },
  recLabel: { fontSize: 16, fontWeight: '700' },
});
