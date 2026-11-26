import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type LayoutRectangle } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut, interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { FRIEND_REPORT_TYPES, type FriendReportType } from '@crewmap/hazards';
import { formatSpeed, kph, speedUnit } from '@crewmap/shared/units';
import { curveAdvisories, nextAdvisory, type CurveAdvisory } from '@crewmap/shared/navigation/advisory';
import { lang, t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { useApp, type VoiceMode } from '../../core/store';
import { useTweenedNumber } from './useTweenedNumber';
import { sayReported } from '../../core/nav';
import { DRIVE_UX } from './driveUx';
import { Bouncy } from '../kit';

const INK = '#0B0F1A';
const SIGN_FONT = 'sans-serif-condensed';

/** Rough Québec outline (lng, lat) — only used to pick the regional speed-limit sign style. */
const QC: [number, number][] = [
  [-74.75, 45.0], [-71.5, 45.0], [-70.0, 45.9], [-69.2, 47.45], [-67.8, 47.1], [-64.0, 48.0], [-57.1, 51.4], [-57.0, 60.5],
  [-79.5, 62.6], [-79.5, 47.5], [-77.5, 46.1], [-75.8, 45.5], [-74.4, 45.3],
];
function inQuebec(lat: number, lng: number): boolean {
  let inside = false;
  for (let i = 0, j = QC.length - 1; i < QC.length; j = i++) {
    const [xi, yi] = QC[i]!;
    const [xj, yj] = QC[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Regulatory speed-limit sign: Québec "VITESSE / MAXIMUM" with red ring, else the North-American "SPEED LIMIT". */
function LimitSign({ limit, quebec }: { limit: number; quebec: boolean }) {
  const w = 64;
  const h = 84;
  return (
    <Svg width={w} height={h} viewBox="0 0 64 84">
      <Rect x={1} y={1} width={62} height={82} rx={7} fill="#fff" />
      <Rect x={3.5} y={3.5} width={57} height={77} rx={5} fill="none" stroke={INK} strokeWidth={2.5} />
      {quebec ? (
        <>
          <SvgText x={32} y={17} fontSize={9.5} fontWeight="bold" fontFamily={SIGN_FONT} fill={INK} textAnchor="middle" letterSpacing={0}>
            {t('sign.vitesse')}
          </SvgText>
          <Circle cx={32} cy={43} r={20} fill="#fff" stroke="#D7262E" strokeWidth={4.5} />
          <SvgText x={32} y={limit >= 100 ? 50.5 : 52.5} fontSize={limit >= 100 ? 19 : 26} fontWeight="bold" fontFamily={SIGN_FONT} fill={INK} textAnchor="middle" {...(limit >= 100 ? { textLength: 27, lengthAdjust: "spacingAndGlyphs" as const } : {})}>
            {String(limit)}
          </SvgText>
          <SvgText x={32} y={75} fontSize={9} fontWeight="bold" fontFamily={SIGN_FONT} fill={INK} textAnchor="middle" letterSpacing={0}>
            {t('sign.maximum')}
          </SvgText>
        </>
      ) : (
        <>
          <SvgText x={32} y={18} fontSize={9.5} fontWeight="bold" fontFamily={SIGN_FONT} fill={INK} textAnchor="middle">
            {t('sign.maximum')}
          </SvgText>
          <SvgText x={32} y={62} fontSize={limit >= 100 ? 30 : 36} fontWeight="bold" fontFamily={SIGN_FONT} fill={INK} textAnchor="middle" {...(limit >= 100 ? { textLength: 48, lengthAdjust: "spacingAndGlyphs" as const } : {})}>
            {String(limit)}
          </SvgText>
          <SvgText x={32} y={75} fontSize={8} fontWeight="bold" fontFamily={SIGN_FONT} fill={INK} textAnchor="middle">
            {speedUnit(lang())}
          </SvgText>
        </>
      )}
    </Svg>
  );
}

const AMBER = '#FFC72C';

/** Yellow advisory panel (curve warning diamond over a km/h plate), like the roadside signs. */
function AdvisorySign({ a }: { a: CurveAdvisory }) {
  const flip = a.side === 'left' ? -1 : 1;
  // Curve arrow drawn for a right bend, mirrored for left; the sharp variant bends to 90°.
  const path = a.sharp ? 'M-6 12 L-6 -2 Q-6 -8 0 -8 L4 -8' : 'M-5 12 Q-5 0 0 -4 Q4 -7 4 -10';
  const head = a.sharp ? 'M2 -12 L8 -8 L2 -4 Z' : 'M0 -11 L4 -16 L8 -10 Z';
  return (
    <Svg width={64} height={88} viewBox="0 0 64 88">
      <G transform="translate(32 28)">
        <Rect x={-19} y={-19} width={38} height={38} rx={4} fill={AMBER} stroke={INK} strokeWidth={2.5} transform="rotate(45)" />
        <G transform={`scale(${flip} 1)`}>
          <Path d={path} stroke={INK} strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <Path d={head} fill={INK} />
        </G>
      </G>
      <Rect x={10} y={58} width={44} height={28} rx={4} fill={AMBER} stroke={INK} strokeWidth={2.5} />
      <SvgText x={32} y={73} fontSize={13} fontWeight="bold" fontFamily={SIGN_FONT} fill={INK} textAnchor="middle">
        {String(a.speedKph)}
      </SvgText>
      <SvgText x={32} y={82.5} fontSize={7.5} fontWeight="bold" fontFamily={SIGN_FONT} fill={INK} textAnchor="middle">
        {speedUnit(lang())}
      </SvgText>
    </Svg>
  );
}

function useCurveAdvisory(): CurveAdvisory | null {
  const route = useApp((s) => (s.nav?.active ? s.nav.route : null));
  const list = useMemo(() => (route ? curveAdvisories(route) : []), [route]);
  // Selects the advisory object itself (stable while it applies), so the HUD does not re-render per fix.
  return useApp((s) => {
    const along = s.nav?.progress?.alongM;
    return along === undefined ? null : nextAdvisory(list, along);
  });
}

/** The tweened number alone re-renders during the glide (a few times per fix), not the whole badge. */
function SpeedNumber({ v, over }: { v: number; over: boolean }) {
  const shown = useTweenedNumber(v);
  return (
    <Text style={[styles.speedNum, over && styles.onRed]} testID="speed-value">
      {shown}
    </Text>
  );
}

/** Calm, high-contrast speed + limit (F1b) with speeding indicator. */
export function SpeedBadge({ onLayout }: { onLayout?: (r: LayoutRectangle) => void }) {
  // Narrow selectors: this badge re-renders when the speed or the limit changes, not on every store update.
  const raw = useApp((s) => kph(s.fix?.speed ?? null) ?? 0);
  const limit = useApp((s) => s.limitKph);
  // GPS speed jitters a few km/h while stopped; show 0 below 3 km/h like car dashboards and Google Maps.
  const v = raw < 3 ? 0 : raw;
  const over = limit !== null && v > limit + 4;
  const advisory = useCurveAdvisory();
  const quebec = useApp((s) => (s.fix ? inQuebec(s.fix.lat, s.fix.lng) : false));
  const overSv = useSharedValue(over ? 1 : 0);
  useEffect(() => {
    overSv.value = withTiming(over ? 1 : 0, { duration: 220 });
  }, [over, overSv]);
  const dial = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(overSv.value, [0, 1], ['#FFFFFF', '#E5484D']) }));
  return (
    <View style={styles.speedWrap} onLayout={(e) => onLayout?.(e.nativeEvent.layout)} pointerEvents="none" testID="speed-badge">
      <Animated.View style={[styles.speed, styles.shadow, dial]}>
        <SpeedNumber v={v} over={over} />
        <Text style={[styles.unit, over && styles.onRedSoft]}>{speedUnit(lang())}</Text>
      </Animated.View>
      {limit !== null && (
        <Animated.View entering={ZoomIn.springify().damping(14)} exiting={ZoomOut.duration(150)} style={styles.shadow} testID="speed-limit" accessibilityLabel={`${t('sign.speedLimit')} ${limit}`}>
          <LimitSign limit={limit} quebec={quebec} />
        </Animated.View>
      )}
      {advisory && (
        <Animated.View key={`${advisory.startAlongM}`} entering={ZoomIn.springify().damping(14)} exiting={ZoomOut.duration(150)} style={styles.shadow} testID="curve-advisory" accessibilityLabel={`${t('sign.curve')} ${formatSpeed(advisory.speedKph, lang())}`}>
          <AdvisorySign a={advisory} />
        </Animated.View>
      )}
    </View>
  );
}

const NEXT_VOICE: Record<VoiceMode, VoiceMode> = { on: 'alerts', alerts: 'off', off: 'on' };
const VOICE_LABEL = { on: 'nav.voiceOn', alerts: 'nav.voiceAlerts', off: 'nav.voiceOff' } as const;

function SpeakerIcon({ mode, color }: { mode: VoiceMode; color: string }) {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24">
      <Path d="M3 9.5v5c0 .55.45 1 1 1h3.2l4.1 3.6c.65.57 1.7.1 1.7-.76V5.66c0-.86-1.05-1.33-1.7-.76L7.2 8.5H4c-.55 0-1 .45-1 1z" fill={color} />
      {mode === 'on' && (
        <>
          <Path d="M16 8.8a4.5 4.5 0 010 6.4" stroke={color} strokeWidth={2} strokeLinecap="round" fill="none" />
          <Path d="M18.6 6.2a8.2 8.2 0 010 11.6" stroke={color} strokeWidth={2} strokeLinecap="round" fill="none" />
        </>
      )}
      {mode === 'alerts' && (
        <G>
          <Path d="M19 6.5l3.6 6.3h-7.2z" fill="#FFC845" stroke="#FFC845" strokeWidth={1} strokeLinejoin="round" />
          <Path d="M19 8.8v2" stroke={INK} strokeWidth={1.4} strokeLinecap="round" />
          <Circle cx={19} cy={11.8} r={0.6} fill={INK} />
        </G>
      )}
      {mode === 'off' && <Path d="M16 9l5 6M21 9l-5 6" stroke="#FF6B6E" strokeWidth={2.2} strokeLinecap="round" />}
    </Svg>
  );
}

/** One tap cycles voice: all sound → hazard alerts only → muted (persisted). */
export function VoiceToggle() {
  const mode = useApp((s) => s.settings.voice) ?? 'on';
  return (
    <Bouncy
      testID="voice-toggle"
      accessibilityRole="button"
      accessibilityLabel={t(VOICE_LABEL[mode])}
      accessibilityState={{ checked: mode === 'on' ? true : mode === 'off' ? false : 'mixed' }}
      hitSlop={10}
      style={[styles.voice, styles.shadow, mode === 'off' ? styles.voiceOff : {}]}
      onPress={() => void engine.saveSettings({ voice: NEXT_VOICE[mode] })}
    >
      <Animated.View key={mode} entering={ZoomIn.duration(160)}>
        <SpeakerIcon mode={mode} color="#fff" />
      </Animated.View>
    </Bouncy>
  );
}

const REPORT_COLOR: Record<FriendReportType, [string, string]> = {
  police: ['#3B6CF6', '#1E47C7'],
  speedTrap: ['#8E5CF2', '#6236C9'],
  hazard: ['#F5A524', '#D9800B'],
  accident: ['#EF4444', '#C12626'],
  construction: ['#F97316', '#CF5508'],
  pothole: ['#64748B', '#475569'],
};

function ReportIcon({ type, size = 34 }: { type: FriendReportType; size?: number }) {
  const c = '#fff';
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {type === 'police' && (
        <>
          <Path d="M12 2.5l7.5 2.8v5.6c0 4.7-3.2 8.7-7.5 10.6-4.3-1.9-7.5-5.9-7.5-10.6V5.3z" fill={c} />
          <Path d="M12 7.6l1.3 2.7 3 .4-2.2 2 .6 3-2.7-1.5-2.7 1.5.6-3-2.2-2 3-.4z" fill="#1E47C7" />
        </>
      )}
      {type === 'speedTrap' && (
        <>
          <Path d="M4 8h3.2l1.5-2.2h6.6L16.8 8H20a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0120 19H4a1.5 1.5 0 01-1.5-1.5v-8A1.5 1.5 0 014 8z" fill={c} />
          <Circle cx={12} cy={13.3} r={3.6} fill="#6236C9" />
          <Circle cx={12} cy={13.3} r={1.6} fill={c} />
        </>
      )}
      {type === 'hazard' && (
        <>
          <Path d="M10.3 3.6a2 2 0 013.4 0l8.1 14a2 2 0 01-1.7 3H3.9a2 2 0 01-1.7-3z" fill={c} />
          <Path d="M12 9v5" stroke="#D9800B" strokeWidth={2.4} strokeLinecap="round" />
          <Circle cx={12} cy={17.2} r={1.3} fill="#D9800B" />
        </>
      )}
      {type === 'accident' && (
        <>
          <Path d="M5 14l1.6-4.4A2 2 0 018.5 8.3h7a2 2 0 011.9 1.3L19 14v4.5a1 1 0 01-1 1h-1.3a1 1 0 01-1-1v-1H8.3v1a1 1 0 01-1 1H6a1 1 0 01-1-1z" fill={c} />
          <Circle cx={8} cy={14.3} r={1.2} fill="#C12626" />
          <Circle cx={16} cy={14.3} r={1.2} fill="#C12626" />
          <Path d="M12 2.5v3M7.2 4l1.3 2.2M16.8 4l-1.3 2.2" stroke={c} strokeWidth={1.8} strokeLinecap="round" />
        </>
      )}
      {type === 'construction' && (
        <>
          <Path d="M10.4 3.5h3.2l5 15.5H5.4z" fill={c} />
          <Path d="M9.1 7.6h5.8l.9 2.8H8.2zM7.5 12.6h9l.9 2.8H6.6z" fill="#CF5508" />
          <Rect x={3} y={19} width={18} height={2.2} rx={1.1} fill={c} />
        </>
      )}
      {type === 'pothole' && (
        <>
          <Path d="M2.5 15.5c2-1 4-1.5 9.5-1.5s7.5.5 9.5 1.5" stroke={c} strokeWidth={2} strokeLinecap="round" fill="none" />
          <Path d="M6 15.6c1.2-3.3 3.4-5 6-5s4.8 1.7 6 5c-1.7 1.5-3.8 2.3-6 2.3s-4.3-.8-6-2.3z" fill={c} />
          <Path d="M9 13.8l1.6 1.2 1.4-1.6 1.4 1.6 1.6-1.2" stroke="#475569" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      )}
    </Svg>
  );
}

function ReportTile({ type, onPress }: { type: FriendReportType; onPress: () => void }) {
  const [a, b] = REPORT_COLOR[type];
  return (
    <Bouncy testID={`report-${type}`} accessibilityLabel={t(`hz.${type}`)} style={[styles.reportBtn, styles.shadow]} onPress={onPress}>
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 84 84" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={`g-${type}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={a} />
            <Stop offset="1" stopColor={b} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={84} height={84} rx={22} fill={`url(#g-${type})`} />
      </Svg>
      <ReportIcon type={type} />
      <Text style={styles.reportLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
        {t(`hz.${type}`)}
      </Text>
    </Bouncy>
  );
}

/** One-tap reports while driving: big buttons, no typing (F4.6). */
export function ReportBar({ onLayout, size = DRIVE_UX.targetDp, music }: { onLayout?: (r: LayoutRectangle) => void; size?: number; /** Music slot (MusicButton): thumb column, above the voice toggle. */ music?: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Non-critical: an open grid closes itself so the map is never left covered.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setOpen(false), DRIVE_UX.reportAutoCloseMs);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <View style={styles.reportWrap} onLayout={(e) => onLayout?.(e.nativeEvent.layout)}>
      {open && (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={styles.reportGrid}>
          {FRIEND_REPORT_TYPES.map((r, i) => (
            <Animated.View key={r} entering={ZoomIn.delay(i * 25).springify().damping(15)}>
              <ReportTile
                type={r}
                onPress={() => {
                  engine.hazards.report(r);
                  setOpen(false);
                  sayReported(r);
                }}
              />
            </Animated.View>
          ))}
        </Animated.View>
      )}
      {!open && music ? <View testID="music-slot">{music}</View> : null}
      {!open && <VoiceToggle />}
      <Bouncy testID="report-open" accessibilityLabel={t('nav.report')} style={[styles.reportFab, { width: size, height: size, borderRadius: size / 2 }, styles.shadow, open ? styles.reportFabOpen : {}]} onPress={() => setOpen((o) => !o)}>
        <Svg width={30} height={30} viewBox="0 0 24 24">
          {open ? (
            <Path d="M6 6l12 12M18 6L6 18" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" />
          ) : (
            <>
              <Path d="M10.3 3.6a2 2 0 013.4 0l8.1 14a2 2 0 01-1.7 3H3.9a2 2 0 01-1.7-3z" fill={INK} />
              <Path d="M12 8.5v6M9 11.5h6" stroke="#FFC845" strokeWidth={2.2} strokeLinecap="round" />
            </>
          )}
        </Svg>
      </Bouncy>
    </View>
  );
}

/** "Still there?" — one big tap (never shown when the next maneuver is < 200 m; the navigator enforces it). */
export function StillThere() {
  const [hazardId, setHazardId] = useState<string | null>(null);
  useEffect(() => {
    const l = (id: string | null) => setHazardId(id);
    engine.nav.confirmListeners.add(l);
    return () => {
      engine.nav.confirmListeners.delete(l);
    };
  }, []);
  useEffect(() => {
    if (!hazardId) return;
    const timer = setTimeout(() => setHazardId(null), 8000);
    return () => clearTimeout(timer);
  }, [hazardId]);
  if (!hazardId) return null;
  const h = useApp.getState().hazards.find((x) => x.id === hazardId);
  const answer = (up: boolean) => {
    if (h) engine.hazards.vote(h.memberIds, up);
    engine.nav.confirmAnswer();
    setHazardId(null);
  };
  return (
    <Animated.View entering={ZoomIn.springify().damping(14)} exiting={FadeOut.duration(150)} style={[styles.still, styles.shadow]} testID="still-there">
      {h && <ReportIcon type={(FRIEND_REPORT_TYPES as readonly string[]).includes(h.type) ? (h.type as FriendReportType) : 'hazard'} size={40} />}
      <Text style={styles.stillQ}>
        {t('nav.stillThere')} {h ? t(`hz.${h.type}`) : ''}
      </Text>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Bouncy style={[styles.stillBtn, { backgroundColor: '#30A46C' }]} onPress={() => answer(true)} accessibilityLabel={t('nav.yes')}>
          <Text style={styles.stillBtnText}>{t('nav.yes')}</Text>
        </Bouncy>
        <Bouncy style={[styles.stillBtn, { backgroundColor: '#E5484D' }]} onPress={() => answer(false)} accessibilityLabel={t('nav.no')}>
          <Text style={styles.stillBtnText}>{t('nav.no')}</Text>
        </Bouncy>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  shadow: { shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 8 },
  speedWrap: { flexDirection: 'column-reverse', alignItems: 'center', gap: 10 },
  speed: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: 'rgba(11,15,26,0.08)' },
  speedNum: { fontSize: 36, fontWeight: '800', color: INK, fontVariant: ['tabular-nums'], letterSpacing: -1, lineHeight: 40 },
  unit: { fontSize: 11, fontWeight: '700', color: '#5A6478', letterSpacing: 0.5 },
  onRed: { color: '#fff' },
  onRedSoft: { color: 'rgba(255,255,255,0.85)' },
  voice: { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(17,22,36,0.92)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  voiceOff: { backgroundColor: 'rgba(60,18,22,0.94)', borderColor: 'rgba(255,107,110,0.5)' },
  reportWrap: { alignItems: 'flex-end', gap: 12 },
  reportFab: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#FFC845', alignItems: 'center', justifyContent: 'center' },
  reportFabOpen: { backgroundColor: '#1B2236' },
  reportGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, width: 272, justifyContent: 'flex-end' },
  reportBtn: { width: 84, height: 84, borderRadius: 22, alignItems: 'center', justifyContent: 'center', gap: 4, overflow: 'hidden' },
  reportLabel: { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 0.2, paddingHorizontal: 4 },
  still: { backgroundColor: 'rgba(17,22,36,0.96)', borderRadius: 24, padding: 18, gap: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  stillQ: { color: '#fff', fontSize: 21, fontWeight: '800' },
  stillBtn: { width: 130, height: 64, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  stillBtnText: { color: '#fff', fontSize: 21, fontWeight: '800' },
});
