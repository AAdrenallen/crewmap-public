import { useEffect, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EMOTE_EMOJI, EMOTE_LIMITS, EMOTE_PRESETS, type EmoteMessage, type EmotePreset } from '@crewmap/shared/emotes';
import { agoParts, formatCountdown } from '@crewmap/shared/friend';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { loadFriendLogs, logEmote, useFriendPrefs, type EmoteLogEntry } from '../../core/friendPrefs';
import { muteForRide, setMuteAllForRide } from '../../core/rideMutes';
import { useApp } from '../../core/store';
import { Bouncy, Button, Card, EmptyState, SectionLabel } from '../../ui/kit';
import { EmoteArt } from '../../ui/emotes/EmoteArt';
import { QuipSection } from '../../ui/emotes/QuipSection';
import { useNow } from '../../ui/friend/useNow';
import { font, palette, type, useTheme } from '../../ui/theme';
import { ScreenHeader } from '../../ui/screens-common/Layout';
import { Icon } from '../../ui/screens-common/Icon';

const NO_LOG: EmoteLogEntry[] = [];
const HISTORY_SHOWN = 6;

/** Emote wheel (also opened by tapping a friend's moving avatar). Custom clip: hold to record ≤ 5 s. */
export default function EmotePicker() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const friend = useApp((s) => s.allFriends[id]);
  const name = friend?.profile.name ?? '';
  const mutedUser = useApp((s) => s.rideMutes.users.includes(id));
  const mutedAll = useApp((s) => s.rideMutes.all);
  const history = useFriendPrefs((s) => s.emotes[id] ?? NO_LOG);
  const [cooldown, setCooldown] = useState(() => engine.emotes.cooldown(id));
  const [recording, setRecording] = useState(false);
  const [failed, setFailed] = useState<EmoteMessage | null>(null);
  const [busy, setBusy] = useState(false);
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
  }, [id]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.back();
      return true;
    });
    return () => sub.remove();
  }, [router]);

  const deliver = async (msg: EmoteMessage) => {
    setBusy(true);
    try {
      const ok = await engine.emotes.send(id, msg);
      setCooldown(engine.emotes.cooldown(id));
      setFailed(ok ? null : msg);
      void logEmote(id, { preset: msg.preset, mine: true, t: Date.now(), ok }).catch(() => undefined);
    } catch {
      setFailed(msg);
      void logEmote(id, { preset: msg.preset, mine: true, t: Date.now(), ok: false }).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const send = (preset: EmotePreset) => void deliver({ preset });

  // Bouncy owns onPressIn/onPressOut for its spring, so the hold-to-record button uses a plain Pressable.
  const recordStart = async () => {
    press.value = withSpring(0.95);
    setRecording(true);
    try {
      const clip = await engine.emotes.recordClip();
      if (clip) await deliver({ preset: 'custom', ...clip });
    } finally {
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
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: th.bg, padding: 16, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16, gap: 14 }}>
      <ScreenHeader title={name} />
      {/* Ride mutes: last until the ride ends (shared/rideMutes). */}
      <View style={styles.mutes}>
        <MuteChip testID="emote-mute-user" on={mutedUser} label={t('emote.muteUser', { name })} onPress={() => muteForRide(id, !mutedUser)} />
        <MuteChip testID="emote-mute-all" on={mutedAll} label={t('emote.muteAll')} onPress={() => setMuteAllForRide(!mutedAll)} />
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
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 14 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <View style={styles.grid}>
        {EMOTE_PRESETS.map((p, i) => (
          <Animated.View key={p} entering={FadeInDown.delay(i * 30).duration(240)} style={styles.cellWrap}>
            <Bouncy
              testID={`emote-${p}`}
              accessibilityLabel={t(`emote.${p}`)}
              disabled={off}
              onPress={() => send(p)}
              style={[styles.cell, { opacity: off ? 0.4 : 1 }]}
            >
              <Text style={styles.emoji}>{EMOTE_EMOJI[p]}</Text>
              <Text style={[styles.label, { color: th.text }]} numberOfLines={2}>
                {t(`emote.${p}`)}
              </Text>
            </Bouncy>
          </Animated.View>
        ))}
      </View>
      {history.length > 0 && (
        <>
          <SectionLabel>{t('emote.recent')}</SectionLabel>
          <Card style={{ paddingVertical: 6 }}>
            <ScrollView style={{ maxHeight: 150 }} nestedScrollEnabled>
              {[...history]
                .reverse()
                .slice(0, HISTORY_SHOWN)
                .map((h) => {
                  const ago = agoParts(h.t, now);
                  return (
                    <View key={`${h.t}-${h.mine ? 'm' : 'f'}`} testID="emote-history-item" style={styles.hist}>
                      <Text style={styles.histEmoji}>{EMOTE_EMOJI[h.preset]}</Text>
                      <Text style={[type.body, { color: h.ok ? th.text : palette.danger, flex: 1 }]} numberOfLines={1}>
                        {`${h.mine ? t('emote.sentBy') : name} · ${label(h.preset)}`}
                      </Text>
                      <Text style={[type.caption, { color: th.textSoft }]}>{t(`friend.ago.${ago.unit}`, { n: ago.n })}</Text>
                    </View>
                  );
                })}
            </ScrollView>
          </Card>
        </>
      )}
      <QuipSection friendId={id} friendName={name} disabled={off} />
      </ScrollView>
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
          <Text style={[styles.recLabel, { color: recording ? '#FFFFFF' : th.text }]}>{recording ? `${EMOTE_LIMITS.maxClipMs / 1000} s` : t('emote.record')}</Text>
        </Pressable>
      </Animated.View>
    </KeyboardAvoidingView>
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
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 18, justifyContent: 'space-between' },
  cellWrap: { width: '23.5%' },
  // No tile box: the emoji + label and the grid spacing carry the grouping (owner: boxes looked too boxy).
  cell: { aspectRatio: 0.9, alignItems: 'center', justifyContent: 'center', padding: 4, gap: 4 },
  emoji: { fontSize: 40, lineHeight: 48 },
  label: { fontSize: 11.5, fontWeight: '700', textAlign: 'center' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, minHeight: 48, borderRadius: 16 },
  hist: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
  histEmoji: { fontSize: 20 },
  record: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, borderRadius: 28, minHeight: 64, borderWidth: 1.5 },
  recLabel: { fontSize: 16, fontWeight: '700' },
});
