import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, BackHandler, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { Easing, FadeIn, type SharedValue, FadeInDown, FadeInLeft, FadeInRight, FadeInUp, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming, ZoomIn } from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { platform, type PermissionState } from '@crewmap/platform';
import { DEFAULT_CAR, randomAvatar, type AvatarConfig, type AvatarPartKey, type CarConfig } from '@crewmap/shared/avatar';
import { t } from '@crewmap/shared/i18n';
import { extractInviteLink } from '@crewmap/shared/links';
import { decodeInvite } from '@crewmap/p2p';
import { loadClipboard, pickupClipboardInvite } from '../core/clipboardInvite';
import { engine } from '../core/engine';
import { inviteErrorMessage, inviteStash } from '../core/inviteErrors';
import { JoinCodeField } from '../ui/JoinCode';
import { notificationsPermission, requestNotifications } from '../core/notify';
import { PART_TABS, PartOptions, PartTabs, RidePicker } from '../ui/avatar/AvatarPickers';
import { AvatarStage } from '../ui/avatar/AvatarStage';
import { pushUndo } from '../ui/avatar/avatarParts';
import { Badge, Button, Card, Chip, Field, Icon, IconButton, IconTile, KeyboardScroll, type IconName } from '../ui/kit';
import { pageX, useLayoutMode } from '../ui/layout';
import { advance, back, celebrateMs, isInviteLink, progress, STAGE_STEPS, STEPS, type Step } from '../ui/onboarding/steps';
import { elevation, font, palette, radius, space, type, useTheme } from '../ui/theme';
import { useReduceMotion } from '../ui/useReduceMotion';

type Screen = Step | 'done';

/** Onboarding column: one readable width on tablets and landscape. */
const COL_MAX = 640;
const TOP_BAR_H = 56;

/** Brand mark: map pin cradling three crew dots. */
function Mark({ size = 96 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 96 96">
      <Defs>
        <LinearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#6E7BFF" />
          <Stop offset="1" stopColor={palette.brandDeep} />
        </LinearGradient>
      </Defs>
      <Path d="M48 90s-30-25-30-50a30 30 0 0 1 60 0c0 25-30 50-30 50z" fill="url(#g)" />
      <Circle cx={36} cy={40} r={7} fill="#FFFFFF" />
      <Circle cx={60} cy={40} r={7} fill={palette.sun} />
      <Circle cx={48} cy={24} r={7} fill={palette.mint} />
    </Svg>
  );
}

/** Soft brand glow behind the hero and the finish (theme-aware, pointer-transparent). */
function Glow({ width, height }: { width: number; height: number }) {
  const th = useTheme();
  return (
    <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}>
      <Defs>
        <RadialGradient id="glowA" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={palette.brand} stopOpacity={th.dark ? 0.32 : 0.18} />
          <Stop offset="1" stopColor={palette.brand} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="glowB" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={palette.mint} stopOpacity={th.dark ? 0.22 : 0.14} />
          <Stop offset="1" stopColor={palette.mint} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={-width * 0.3} y={-height * 0.08} width={width * 1.3} height={height * 0.6} fill="url(#glowA)" />
      <Rect x={width * 0.25} y={height * 0.45} width={width * 1.0} height={height * 0.6} fill="url(#glowB)" />
    </Svg>
  );
}

function ProgressSeg({ on }: { on: boolean }) {
  const th = useTheme();
  const fill = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    fill.value = withTiming(on ? 1 : 0, { duration: 320, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System });
  }, [on, fill]);
  const style = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }));
  return (
    <View style={[styles.seg, { backgroundColor: th.border }]}>
      <Animated.View style={[styles.segFill, { backgroundColor: th.accent }, style]} />
    </View>
  );
}

function TopBar({ step, onBack }: { step: Step; onBack: () => void }) {
  const p = progress(step);
  return (
    <View style={styles.topBar}>
      <IconButton testID="onb-back" icon="back" tone="plain" label={t('common.back')} onPress={onBack} />
      <View style={styles.progress} accessible accessibilityRole="progressbar" accessibilityLabel={t('onb.progress', { n: p.n, total: p.total })}>
        {STEPS.map((s, i) => (
          <ProgressSeg key={s} on={i < p.n} />
        ))}
      </View>
      <View style={{ width: 48 }} />
    </View>
  );
}

function PermCard({ icon, label, state, onAllow, testID, required }: { icon: IconName; label: string; state: PermissionState; onAllow: () => void; testID: string; required?: boolean }) {
  const th = useTheme();
  const granted = state === 'granted';
  return (
    <Card style={[styles.perm, granted && { backgroundColor: th.dark ? 'rgba(61,214,140,0.08)' : 'rgba(34,160,107,0.06)' }]} flat>
      <IconTile icon={granted ? 'check' : icon} color={granted ? th.ok : th.accent} size={44} />
      <View style={{ flex: 1 }}>
        <View style={styles.permHead}>
          <Text style={[type.headline, { color: th.text, flexShrink: 1 }]} numberOfLines={1}>
            {label}
          </Text>
          {required && !granted && <Badge label={t('onb.required')} />}
        </View>
      </View>
      {granted ? (
        <View style={styles.allowed} accessibilityLabel={`${label}: ${t('onb.allowed')}`}>
          <Text style={[type.small, { color: th.ok }]}>{t('onb.allowed')}</Text>
        </View>
      ) : (
        <Chip testID={testID} label={state === 'denied' ? t('onb.openSettings') : t('onb.allow')} active onPress={onAllow} />
      )}
    </Card>
  );
}

/** Step body entrance: slides from the side the user is heading to (system reduce-motion turns it off). */
function StepView({ id, dir, children, style }: { id: string; dir: 1 | -1; children: ReactNode; style?: object }) {
  const enter = (dir > 0 ? FadeInRight : FadeInLeft).springify().damping(20).stiffness(180).reduceMotion(ReduceMotion.System);
  return (
    <Animated.View key={id} entering={enter} style={style}>
      {children}
    </Animated.View>
  );
}

/** "You're in": the mark pops, a ring of crew dots bursts out, then the map. Tap to skip. */
function Done({ name, onContinue }: { name: string; onContinue: () => void }) {
  const th = useTheme();
  const lay = useLayoutMode();
  const burst = useSharedValue(0);
  useEffect(() => {
    burst.value = withDelay(120, withSpring(1, { damping: 14, stiffness: 90, reduceMotion: ReduceMotion.System }));
  }, [burst]);
  const dots = [palette.brand, palette.sun, palette.mint, palette.pop, palette.brand, palette.sun, palette.mint, palette.pop];
  return (
    <Pressable testID="onb-done" accessibilityRole="button" accessibilityLabel={t('onb.youreIn', { name })} onPress={onContinue} style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: th.bg }]}>
      <Glow width={lay.width} height={lay.height} />
      <View style={styles.center}>
        {dots.map((c, i) => (
          <BurstDot key={i} color={c} angle={(i / dots.length) * Math.PI * 2} burst={burst} />
        ))}
        <Animated.View entering={ZoomIn.springify().damping(12).reduceMotion(ReduceMotion.System)}>
          <Mark size={120} />
        </Animated.View>
      </View>
      <Animated.Text entering={FadeInUp.delay(160).springify().damping(18).reduceMotion(ReduceMotion.System)} style={[type.hero, { color: th.text, textAlign: 'center', marginTop: space(8), paddingHorizontal: space(6) }]} numberOfLines={2}>
        {t('onb.youreIn', { name })}
      </Animated.Text>
    </Pressable>
  );
}

function BurstDot({ color, angle, burst }: { color: string; angle: number; burst: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const r = 46 + burst.value * 64;
    return { opacity: burst.value < 0.05 ? 0 : 1 - Math.max(0, burst.value - 0.7) * 2, transform: [{ translateX: Math.cos(angle) * r }, { translateY: Math.sin(angle) * r }, { scale: 0.4 + burst.value * 0.6 }] };
  });
  return <Animated.View style={[styles.burstDot, { backgroundColor: color }, style]} />;
}

export default function Onboarding() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  const reduceMotion = useReduceMotion();
  const [step, setStepRaw] = useState<Screen>('name');
  const dir = useRef<1 | -1>(1);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<AvatarConfig>(() => randomAvatar());
  const [undo, setUndo] = useState<AvatarConfig[]>([]);
  const [part, setPart] = useState<AvatarPartKey>('hair');
  const [car, setCar] = useState<CarConfig>(DEFAULT_CAR);
  const [crewName, setCrewName] = useState('');
  const [link, setLink] = useState(() => inviteStash.peek() ?? '');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [perms, setPerms] = useState({ fg: 'undetermined' as PermissionState, bg: 'undetermined' as PermissionState, motion: 'undetermined' as PermissionState, notif: 'undetermined' as PermissionState, battery: false });

  const go = useCallback((to: Screen, d: 1 | -1) => {
    dir.current = d;
    setStepRaw(to);
  }, []);

  const refresh = useCallback(async () => {
    setPerms({
      fg: await platform.location.foregroundPermission(),
      bg: await platform.location.backgroundPermission(),
      motion: await platform.motion.permission(),
      notif: await notificationsPermission(),
      battery: platform.power.isIgnoringBatteryOptimizations(),
    });
  }, []);
  useEffect(() => {
    void refresh();
    // Back from system settings (background location, battery, a denied permission): re-read every state.
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void refresh());
    return () => sub.remove();
  }, [refresh]);

  // A link opened before onboarding (possibly before a restart): prefill it.
  useEffect(() => {
    void inviteStash.load().then((l) => l && setLink((cur) => cur || l));
  }, []);

  // Installed from the join page, which copied the invite: pick it up from the clipboard (on launch and on each return
  // to the app until found). Android only lets a focused app read it, hence the short delay. Joining still needs a tap.
  const [fromClip, setFromClip] = useState(false);
  const linkRef = useRef(link);
  linkRef.current = link;
  useEffect(() => {
    let found = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryPickup = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (found || isInviteLink(linkRef.current)) return;
        const clip = await loadClipboard();
        const l = clip && (await pickupClipboardInvite(clip, (v) => inviteStash.stash(v)));
        if (!l || found) return;
        found = true;
        setLink((cur) => (isInviteLink(cur) ? cur : l));
        setFromClip(true);
      }, 400);
    };
    tryPickup();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && tryPickup());
    return () => {
      sub.remove();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const inviteName = (() => {
    const l = extractInviteLink(link);
    try {
      return l ? decodeInvite(l).n : '';
    } catch {
      return '';
    }
  })();

  const goBack = useCallback((): boolean => {
    if (step === 'done') return true;
    const prev = back(step);
    if (!prev) return false;
    go(prev, -1);
    return true;
  }, [step, go]);
  // Only while focused: on /scan (pushed over onboarding) back must close the scanner, not step back underneath.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', goBack);
      return () => sub.remove();
    }, [goBack]),
  );

  const saveProfile = () => engine.saveProfile({ name: name.trim(), avatar, car });

  // Once: the celebration timer and a tap on it may both fire.
  const entered = useRef(false);
  const enterMap = useCallback(() => {
    if (entered.current) return;
    entered.current = true;
    router.replace('/');
  }, [router]);

  const finish = async (mode: 'create' | 'join', codeLink?: string) => {
    setBusy(mode);
    setError(null);
    try {
      await saveProfile();
      if (mode === 'create') await engine.crews.create(crewName.trim(), name.trim());
      else await engine.crews.join(codeLink ?? extractInviteLink(link) ?? link.trim(), name.trim());
      await engine.finishOnboarding();
      await inviteStash.clear();
      const hold = celebrateMs(reduceMotion);
      if (hold === 0) {
        enterMap();
        return;
      }
      go('done', 1);
      setTimeout(enterMap, hold);
    } catch (e) {
      setError(mode === 'join' ? inviteErrorMessage(e) : (e as Error).message);
      go('crew', 1);
    } finally {
      setBusy(null);
    }
  };

  const next = () => {
    if (step === 'done') return;
    const a = advance(step, { name, locationGranted: perms.fg === 'granted', link, linkFromClipboard: fromClip });
    if (!a) return;
    if (a.kind === 'join') void finish('join');
    else go(a.step, 1);
  };

  /** Denied once: ask again; still not granted (never ask again) → the app's system settings. */
  const ask = async (state: PermissionState, request: () => Promise<PermissionState>) => {
    const r = await request();
    if (state === 'denied' && r !== 'granted') await Linking.openSettings().catch(() => undefined);
    await refresh();
  };

  const page = { ...pageX(lay, 20), maxWidth: COL_MAX };
  const colW = Math.min(lay.width, COL_MAX) - page.paddingLeft - page.paddingRight;

  if (step === 'done') return <Done name={name.trim()} onContinue={enterMap} />;

  const onStage = STAGE_STEPS.includes(step);
  const d = dir.current;

  if (onStage) {
    const wide = lay.wide;
    const availH = lay.height - insets.top - TOP_BAR_H - insets.bottom;
    const stageW = wide ? Math.round((lay.width - page.paddingLeft - page.paddingRight) * 0.42) : colW;
    const stageH = wide ? Math.max(200, availH - space(4)) : Math.round(Math.min(Math.max(lay.height * 0.36, 220), 380));
    const ride = step === 'ride';
    return (
      <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top }}>
        <View style={[page, { maxWidth: wide ? undefined : COL_MAX }]}>
          <TopBar step={step} onBack={goBack} />
        </View>
        <View style={[page, { flex: 1, maxWidth: wide ? undefined : COL_MAX, flexDirection: wide ? 'row' : 'column', gap: space(4) }]}>
          <Animated.View entering={FadeIn.duration(260).reduceMotion(ReduceMotion.System)} style={[{ borderRadius: radius.xl, backgroundColor: th.card }, elevation.low]}>
            {/* One stage for both steps (kept mounted): the camera eases from the character to the ride. */}
            <AvatarStage testID="onb-stage" avatar={avatar} car={car} ride={ride} focus={part} width={stageW} height={stageH} rounded>
              {!ride && (
                <View style={styles.stageActions}>
                  {undo.length > 0 && (
                    <IconButton
                      testID="onb-undo"
                      icon="undo"
                      label={t('common.undo')}
                      onPress={() => {
                        setAvatar(undo[undo.length - 1]!);
                        setUndo(undo.slice(0, -1));
                      }}
                    />
                  )}
                  <Chip
                    testID="onb-shuffle"
                    icon="shuffle"
                    label={t('onb.shuffle')}
                    active
                    onPress={() => {
                      setUndo((u) => pushUndo(u, avatar));
                      setAvatar(randomAvatar());
                    }}
                  />
                </View>
              )}
            </AvatarStage>
          </Animated.View>
          <View style={{ flex: 1, gap: space(3) }}>
            <StepView id={step} dir={d} style={{ flex: 1, gap: space(3) }}>
              <Text accessibilityRole="header" style={[type.title, { color: th.text }]}>
                {ride ? t('onb.ride') : t('onb.avatar')}
              </Text>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: space(4), paddingBottom: space(2) }} showsVerticalScrollIndicator={false}>
                {ride ? (
                  <RidePicker car={car} onChange={setCar} layout="scroll" testPrefix="onb" />
                ) : (
                  <>
                    <PartTabs tabs={PART_TABS} active={part} onPick={setPart} testPrefix="onb" />
                    <PartOptions value={avatar} tab={part} onChange={setAvatar} testPrefix="onb" />
                  </>
                )}
              </ScrollView>
            </StepView>
            <View style={{ paddingBottom: insets.bottom + space(4) }}>
              <Button testID="onb-next" label={t('onb.next')} loading={busy === 'join'} disabled={busy !== null} onPress={next} />
            </View>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      {step === 'name' && <Glow width={lay.width} height={lay.height} />}
      <KeyboardScroll contentContainerStyle={{ ...page, paddingTop: insets.top + space(3), paddingBottom: insets.bottom + space(6), gap: space(4), flexGrow: 1 }}>
        {step !== 'name' && <TopBar step={step} onBack={goBack} />}

        {step === 'name' && (
          <View style={styles.hero}>
            <View style={styles.heroTop}>
              <Animated.View entering={ZoomIn.springify().damping(14).reduceMotion(ReduceMotion.System)}>
                <Mark size={lay.landscape ? 84 : 120} />
              </Animated.View>
              <Animated.Text entering={FadeInUp.delay(120).springify().damping(18).reduceMotion(ReduceMotion.System)} style={[type.hero, { color: th.text, fontSize: 44, lineHeight: 52 }]}>
                {t('appName')}
              </Animated.Text>
            </View>
            <Animated.View entering={FadeInDown.delay(220).springify().damping(18).reduceMotion(ReduceMotion.System)} style={{ gap: space(4) }}>
              <Field testID="onb-name" label={t('onb.name')} icon="person" value={name} onChangeText={setName} autoFocus maxLength={24} returnKeyType="next" onSubmitEditing={next} />
              <Button testID="onb-next" label={t('onb.next')} disabled={name.trim().length < 1} onPress={next} />
            </Animated.View>
          </View>
        )}

        {step === 'perms' && (
          <StepView id={step} dir={d} style={{ gap: space(3), flex: 1 }}>
            <Text accessibilityRole="header" style={[type.title, { color: th.text, marginBottom: space(1) }]}>
              {t('onb.perms')}
            </Text>
            <PermCard testID="perm-fg" icon="pin" label={t('onb.location')} required state={perms.fg} onAllow={() => void ask(perms.fg, () => platform.location.requestForeground())} />
            <PermCard
              testID="perm-bg"
              icon="locate"
              label={t('onb.locationAlways')}
             
              state={perms.fg !== 'granted' ? 'undetermined' : perms.bg}
              onAllow={async () => {
                if (perms.fg !== 'granted') await platform.location.requestForeground();
                await ask(perms.bg, () => platform.location.requestBackground());
              }}
            />
            <PermCard testID="perm-motion" icon="motion" label={t('onb.motion')} state={perms.motion} onAllow={() => void ask(perms.motion, () => platform.motion.request())} />
            <PermCard testID="perm-notif" icon="bell" label={t('onb.notifications')} state={perms.notif} onAllow={() => void ask('undetermined', requestNotifications)} />
            <PermCard
              testID="perm-battery"
              icon="bolt"
              label={t('onb.battery')}
             
              state={perms.battery ? 'granted' : 'undetermined'}
              onAllow={() => {
                platform.power.requestIgnoreBatteryOptimizations();
                setTimeout(() => void refresh(), 1500);
              }}
            />
            {!['google', 'pixel'].includes(platform.power.device().manufacturer) && (
              <View style={{ alignSelf: 'flex-start' }}>
                <Chip testID="perm-oem" icon="settings" label={`${t('onb.oemSteps')} · ${platform.power.device().manufacturer}`} onPress={() => platform.power.openOemBatterySettings()} />
              </View>
            )}
            <View style={{ flex: 1, minHeight: space(2) }} />
            <Button testID="onb-next" label={t('onb.next')} disabled={perms.fg !== 'granted'} onPress={next} />
          </StepView>
        )}

        {step === 'crew' && (
          <StepView id={step} dir={d} style={{ gap: space(3) }}>
            <Text accessibilityRole="header" style={[type.title, { color: th.text, marginBottom: space(1) }]}>
              {t('onb.circle')}
            </Text>
            {/* A pending invite (tapped link or clipboard pickup) goes first: one tap joins. */}
            {(() => {
              const createCard = (
                <Card style={{ gap: space(3.5) }}>
                  <View style={styles.cardHead}>
                    <IconTile icon="crew" />
                    <Text style={[type.headline, { color: th.text }]}>{t('onb.create')}</Text>
                  </View>
                  <Field testID="onb-crew-name" label={t('onb.crewName')} hideLabel placeholder={t('onb.crewName')} icon="users" value={crewName} onChangeText={setCrewName} maxLength={32} returnKeyType="done" onSubmitEditing={() => crewName.trim() && !busy && void finish('create')} />
                  <Button testID="onb-create" kind={isInviteLink(link) ? 'secondary' : 'primary'} label={t('onb.create')} loading={busy === 'create'} disabled={busy !== null || crewName.trim().length < 1} onPress={() => void finish('create')} />
                </Card>
              );
              const or = (
                <View style={styles.or}>
                  <View style={[styles.orLine, { backgroundColor: th.separator }]} />
                  <Text style={[type.overline, { color: th.textFaint }]}>{t('onb.or')}</Text>
                  <View style={[styles.orLine, { backgroundColor: th.separator }]} />
                </View>
              );
              const joinCard = (
                <Card style={{ gap: space(3.5) }}>
                  <View style={styles.cardHead}>
                    <IconTile icon="link" color={palette.mint} />
                    <Text testID="onb-join-title" style={[type.headline, { color: th.text, flex: 1 }]}>{inviteName ? t('onb.joinNamed', { name: inviteName }) : t('onb.join')}</Text>
                  </View>
                  <Field
                    testID="onb-link"
                    label={t('onb.join')}
                    hideLabel
                    placeholder="crewmap://join#…"
                    icon="link"
                    value={link}
                    onChangeText={(v) => {
                      setFromClip(false);
                      setLink(extractInviteLink(v) ?? v.trim());
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <View style={{ flexDirection: 'row', gap: space(2.5) }}>
                    <View style={{ flex: 1 }}>
                      <Button testID="onb-join" kind={isInviteLink(link) ? 'primary' : 'secondary'} label={busy === 'join' ? t('circle.joining') : t('onb.join')} disabled={busy !== null || !isInviteLink(link)} onPress={() => void finish('join')} />
                    </View>
                    <Button
                      kind="ghost"
                      icon="qr"
                      label={t('circle.scan')}
                      disabled={busy !== null}
                      onPress={async () => {
                        await saveProfile();
                        router.push('/scan');
                      }}
                    />
                  </View>
                  <JoinCodeField disabled={busy !== null} onLink={(l) => void finish('join', l)} />
                </Card>
              );
              return isInviteLink(link) ? <>{joinCard}{or}{createCard}</> : <>{createCard}{or}{joinCard}</>;
            })()}
            {error && (
              <Animated.View entering={FadeIn.duration(200)} style={[styles.error, { backgroundColor: `${th.danger}1A` }]}>
                <Icon name="alert" size={18} color={th.danger} />
                <Text style={[type.body, font('semibold'), { color: th.danger, flex: 1 }]}>{error}</Text>
              </Animated.View>
            )}
          </StepView>
        )}
      </KeyboardScroll>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: space(2), marginLeft: -space(2), height: TOP_BAR_H },
  progress: { flex: 1, flexDirection: 'row', gap: space(1.5) },
  seg: { flex: 1, height: 5, borderRadius: 3, overflow: 'hidden' },
  segFill: { height: '100%', borderRadius: 3 },
  hero: { flex: 1, justifyContent: 'space-between', gap: space(8), paddingTop: space(6) },
  heroTop: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space(3.5) },
  perm: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingVertical: space(3.5) },
  permHead: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  allowed: { flexDirection: 'row', alignItems: 'center', gap: space(1), paddingHorizontal: space(1) },
  stageActions: { position: 'absolute', right: space(3), bottom: space(3), flexDirection: 'row', alignItems: 'center', gap: space(2) },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  or: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(2) },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth },
  error: { flexDirection: 'row', alignItems: 'center', gap: space(2.5), borderRadius: radius.m, padding: space(3) },
  burstDot: { position: 'absolute', width: 14, height: 14, borderRadius: 7 },
});
