import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { formatKm, formatMinutes, kph } from '@crewmap/shared/units';
import { lang, t } from '@crewmap/shared/i18n';
import { useApp } from '../../core/store';
import { Bouncy, Icon } from '../kit';
import { engine } from '../../core/engine';
import { sayFaster } from '../../core/nav';
import type { ProximityMoment } from '@crewmap/shared/places';
import {
  DRIVE_UX,
  smoothStreakMin,
  enqueue,
  nextMotion,
  queueChip,
  release,
  routeInterrupt,
  allowRepeat,
  friendContext,
  momentNotice,
  noticeMs,
  noticePolicy,
  type FriendContext,
  type Interrupt,
  type Motion,
  type NoticeAction,
} from './driveUx';

/** Moving / stopped with hysteresis; re-renders only when the state flips. */
export function useMotion(): Motion {
  const v = useApp((s) => Math.round(kph(s.fix?.speed ?? null) ?? 0));
  const [motion, setMotion] = useState<Motion>('stopped');
  const below = useRef<number | null>(null);
  useEffect(() => {
    const now = Date.now();
    if (v >= DRIVE_UX.stoppedKph) below.current = null;
    else below.current ??= now;
    setMotion((m) => nextMotion(m, v, below.current, now));
    // A stop is only confirmed after the hold, even if no new fix arrives.
    if (below.current === null) return;
    const timer = setTimeout(
      () => setMotion((m) => nextMotion(m, v, below.current, Date.now())),
      DRIVE_UX.stopHoldMs + 50,
    );
    return () => clearTimeout(timer);
  }, [v]);
  return motion;
}

/** The one driving-context selector for friend features: browsing the map vs driving / navigating (moving or stopped). */
export function useFriendContext(): FriendContext {
  const driving = useApp((s) => s.driving || s.nav?.active === true);
  const motion = useMotion();
  return friendContext(driving, motion);
}

const seenMoments = new Map<string, number>();

/**
 * Proximity / pass-place notices: never sticky (auto-close), rate-limited per pair, routed by `noticePolicy`: a brief
 * pill while driving, deferred to the next stop, or dropped (two other friends meeting while I'm moving).
 */
export function useMomentNotice(ctx: FriendContext): {
  moment: ProximityMoment | null;
  action: NoticeAction | null;
  deferred: number;
  dismiss: () => void;
} {
  const moments = useApp((s) => s.moments);
  const next = useApp((s) => s.nav?.progress?.next?.distanceM ?? null);
  const meId = useApp((s) => s.me?.deviceId ?? null);
  const handled = useRef(new WeakSet<ProximityMoment>());
  const [cur, setCur] = useState<{ m: ProximityMoment; action: NoticeAction } | null>(null);
  const [deferred, setDeferred] = useState<ProximityMoment[]>([]);
  useEffect(() => {
    for (const m of moments) {
      if (handled.current.has(m)) continue;
      handled.current.add(m);
      const n = momentNotice(m, meId);
      if (!allowRepeat(seenMoments, n.key, Date.now())) continue;
      const action = noticePolicy(n.kind, ctx, next);
      if (action === 'drop') continue;
      if (action === 'defer') setDeferred((d) => [...d, m].slice(-3));
      else setCur({ m, action });
    }
  }, [moments]);
  // Leaving the moving state releases the newest deferred notice (re-checked against the current context).
  useEffect(() => {
    if (ctx === 'driveMoving' || deferred.length === 0) return;
    const fresh = deferred.filter((m) => Date.now() - m.t <= DRIVE_UX.queueMaxAgeMs);
    setDeferred([]);
    const m = fresh[fresh.length - 1];
    if (!m) return;
    const action = noticePolicy(momentNotice(m, meId).kind, ctx, next);
    if (action === 'toast' || action === 'pill') setCur({ m, action });
  }, [ctx]);
  useEffect(() => {
    if (!cur) return;
    const timer = setTimeout(() => setCur(null), noticeMs(cur.action));
    return () => clearTimeout(timer);
  }, [cur]);
  return {
    moment: cur?.m ?? null,
    action: cur?.action ?? null,
    deferred: deferred.length,
    dismiss: () => setCur(null),
  };
}

/**
 * Non-urgent items (crew chat; friend moments go through `useMomentNotice`) while driving: queued as one small chip while moving, released at the
 * next stop. Returns the chip plus `released` items for the stopped HUD.
 */
export function useDriveQueue(motion: Motion): {
  chip: ReturnType<typeof queueChip>;
  released: number;
  clear: () => void;
} {
  const chat = useApp((s) => Object.values(s.chatUnread).reduce((n, x) => n + x, 0));
  const next = useApp((s) => s.nav?.progress?.next?.distanceM ?? null);
  const [q, setQ] = useState<Interrupt[]>([]);
  const [released, setReleased] = useState(0);
  const prevChat = useRef(chat);
  useEffect(() => {
    if (chat > prevChat.current && noticePolicy('chat', friendContext(true, motion), next) === 'defer')
      setQ((x) => enqueue(x, { id: `chat:${chat}`, kind: 'chat', at: Date.now() }));
    prevChat.current = chat;
  }, [chat]);
  useEffect(() => {
    if (motion !== 'stopped') return;
    setQ((x) => {
      const r = release(x, motion, Date.now());
      if (r.show.length) setReleased((n) => n + r.show.length);
      return r.keep;
    });
  }, [motion]);
  return { chip: queueChip(q), released, clear: () => setReleased(0) };
}

/** The single small "n waiting" chip: never a modal, no touch needed (it clears itself at the next stop). */
export function QueueChip({ count, onPress }: { count: number; onPress?: (() => void) | undefined }) {
  if (count <= 0) return null;
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
      <Bouncy
        testID="drive-queue-chip"
        accessibilityLabel={t('drive.queued', { n: count })}
        onPress={onPress}
        disabled={!onPress}
        style={styles.chip}
      >
        <Icon name="chat" size={18} color="#fff" />
        <Text style={styles.chipText}>{count}</Text>
      </Bouncy>
    </Animated.View>
  );
}

/** ETA pill: tap or swipe up opens trip details (arrival, share ETA, end) that close themselves. */
export function EtaPill({
  remainingS,
  remainingM,
  onEnd,
  onShare,
  endDp,
  children,
}: {
  remainingS: number;
  remainingM: number;
  onEnd: () => void;
  onShare: () => void;
  endDp: number;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setOpen(false), DRIVE_UX.detailsAutoCloseMs);
    return () => clearTimeout(timer);
  }, [open]);
  const swipe = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetY([-16, 16])
    .onEnd((e) => {
      if (e.translationY < -24) setOpen(true);
      else if (e.translationY > 24) setOpen(false);
    });
  const arrival = new Date(Date.now() + remainingS * 1000).toLocaleTimeString(lang(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return (
    <GestureDetector gesture={swipe}>
      <View style={styles.pillWrap}>
        {open && (
          <Animated.View
            entering={FadeInDown.duration(180)}
            exiting={FadeOutDown.duration(150)}
            style={styles.details}
            testID="trip-details"
          >
            <Text style={styles.detailsArrive}>{arrival}</Text>
            <Text
              style={styles.detailsSub}
            >{`${formatMinutes(remainingS)} · ${formatKm(remainingM / 1000, lang())}`}</Text>
            <Bouncy
              testID="trip-share-eta"
              accessibilityLabel={t('drive.shareEta')}
              onPress={() => {
                setOpen(false);
                onShare();
              }}
              style={[styles.detailsBtn, { minHeight: DRIVE_UX.targetDp }]}
            >
              <Icon name="share" size={22} color="#fff" />
              <Text style={styles.detailsBtnText}>{t('drive.shareEta')}</Text>
            </Bouncy>
          </Animated.View>
        )}
        <View style={styles.pillRow}>
          <Bouncy
            testID="nav-eta"
            accessibilityLabel={t('drive.details')}
            onPress={() => setOpen((o) => !o)}
            style={styles.eta}
          >
            <Text style={styles.etaMin}>{formatMinutes(remainingS)}</Text>
            <Text style={styles.etaSub}>{`${formatKm(remainingM / 1000, lang())} · ${arrival}`}</Text>
          </Bouncy>
          {children}
          <Bouncy
            accessibilityLabel={t('nav.end')}
            testID="nav-end"
            onPress={onEnd}
            style={[styles.endBtn, { minHeight: endDp, minWidth: endDp }]}
          >
            <Text style={styles.endText}>{t('nav.end')}</Text>
          </Bouncy>
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(17,22,36,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  chipText: { color: '#fff', fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  pillWrap: { gap: 10 },
  pillRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  eta: { flex: 1, justifyContent: 'center', minHeight: 64 },
  etaMin: { color: '#3DD68C', fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'] },
  etaSub: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '700' },
  endBtn: {
    borderRadius: 16,
    paddingHorizontal: 18,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#E5484D',
  },
  endText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  details: { gap: 8, paddingTop: 6 },
  detailsArrive: { color: '#fff', fontSize: 34, fontWeight: '800', fontVariant: ['tabular-nums'] },
  detailsSub: { color: 'rgba(255,255,255,0.7)', fontSize: 15, fontWeight: '700' },
  detailsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  faster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    paddingLeft: 16,
    borderRadius: 22,
    backgroundColor: 'rgba(17,22,36,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(61,214,140,0.45)',
    maxWidth: 420,
  },
  fasterText: { flexShrink: 1, color: '#fff', fontSize: 17, fontWeight: '800' },
  fasterBtn: {
    borderRadius: 16,
    paddingHorizontal: 20,
    justifyContent: 'center',
    backgroundColor: '#30A46C',
  },
  fasterBtnText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  fasterX: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  streak: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: 'rgba(17,22,36,0.92)',
  },
  streakText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  detailsBtnText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});

/** "Faster route · saves N min": one big Take tap, auto-dismiss, held back near a manoeuvre, spoken once (voice 'on'). */
export function FasterOffer({ motion }: { motion: Motion }) {
  const offer = useApp((s) => s.nav?.faster ?? null);
  const next = useApp((s) => s.nav?.progress?.next?.distanceM ?? null);
  const visible = offer !== null && routeInterrupt('faster', motion, next) === 'show';
  const spoken = useRef<number | null>(null);
  useEffect(() => {
    if (!visible || !offer || spoken.current === offer.createdAt) return;
    spoken.current = offer.createdAt;
    sayFaster(offer.savesS);
    const timer = setTimeout(() => engine.nav.dismissFaster(), DRIVE_UX.fasterAutoCloseMs);
    return () => clearTimeout(timer);
  }, [visible, offer]);
  if (!visible || !offer) return null;
  const min = Math.max(1, Math.round(offer.savesS / 60));
  return (
    <Animated.View
      entering={FadeInDown.duration(200)}
      exiting={FadeOutDown.duration(150)}
      style={styles.faster}
      testID="faster-offer"
    >
      <Text style={styles.fasterText} numberOfLines={2}>
        {t('nav.faster', { min })}
      </Text>
      <Bouncy
        testID="faster-take"
        accessibilityLabel={t('nav.fasterTake')}
        onPress={() => engine.nav.acceptFaster()}
        style={[styles.fasterBtn, { minHeight: DRIVE_UX.targetDp }]}
      >
        <Text style={styles.fasterBtnText}>{t('nav.fasterTake')}</Text>
      </Bouncy>
      <Bouncy
        testID="faster-dismiss"
        accessibilityLabel={t('common.cancel')}
        onPress={() => engine.nav.dismissFaster()}
        style={styles.fasterX}
      >
        <Icon name="close" size={22} color="#fff" />
      </Bouncy>
    </Animated.View>
  );
}

/** Calm trip-end card ("smooth drive") after a clean driver trip; never while guiding near a turn, gone in 6 s. */
export function TripEndCard() {
  const last = useApp((s) => s.lastTripEnd);
  const navigating = useApp((s) => s.nav?.active === true);
  const [shown, setShown] = useState<string | null>(null);
  const min = last ? smoothStreakMin(last) : null;
  const fresh =
    last !== null && min !== null && !navigating && Date.now() - last.at < 60_000 && shown !== last.id;
  useEffect(() => {
    if (!fresh || !last) return;
    const timer = setTimeout(() => setShown(last.id), DRIVE_UX.celebrateMs);
    return () => clearTimeout(timer);
  }, [fresh, last]);
  if (!fresh || min === null) return null;
  return (
    <Animated.View
      entering={FadeIn.duration(300)}
      exiting={FadeOut.duration(250)}
      pointerEvents="none"
      style={styles.streak}
      testID="trip-streak"
    >
      <Icon name="sparkle" size={20} color="#FFC845" />
      <Text style={styles.streakText}>{t('drive.streak', { n: min })}</Text>
    </Animated.View>
  );
}
