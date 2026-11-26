import { useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type LayoutRectangle } from 'react-native';
import Animated, { FadeInDown, FadeOutUp, withTiming, type EntryExitAnimationFunction } from 'react-native-reanimated';
import Svg, { Circle, G, Defs, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { matchingIndication, type Lane, type ManeuverModifier, type ManeuverType, type ProgressState } from '@crewmap/shared/navigation';
import { formatNavDistance } from '@crewmap/shared/units';
import { lang, t } from '@crewmap/shared/i18n';

import { useApp } from '../../core/store';
import { ANGLE, VIEWBOX, approachProgress, glyphBounds, headPts, splitDuration, timeToTurnS } from './maneuverGeom';
import { CELL, laneDividers, laneShape, laneStripLayout, strokeUnits } from './laneGlyphs';

const RAMPS = new Set<string>(['off ramp', 'on ramp', 'fork', 'merge']);
const ROUNDABOUTS = new Set<string>(['roundabout', 'rotary', 'roundabout turn', 'exit roundabout', 'exit rotary']);

/** Arrowhead triangle at (x, y) pointing along `deg` (0 = up, clockwise). */
function head(x: number, y: number, deg: number, k = 1): string {
  const pts = headPts(x, y, deg, k).map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`);
  return `M${pts[0]} L${pts[1]} L${pts[2]} Z`;
}

/** Stem from the bottom centre bending toward `a` degrees, with its head. */
function turnArrow(a: number, color: string, sw: number, key?: string): ReactNode {
  const r = (a * Math.PI) / 180;
  const len = 15;
  const ex = 24 + Math.sin(r) * len;
  const ey = 24 - Math.cos(r) * len;
  return (
    <Path key={key ? `${key}s` : undefined} d={`M24 44V28 Q24 24 ${ex.toFixed(2)} ${ey.toFixed(2)}`} stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" />
  );
}
function turnHead(a: number, color: string, key?: string, k = 1): ReactNode {
  const r = (a * Math.PI) / 180;
  return <Path key={key ? `${key}h` : undefined} d={head(24 + Math.sin(r) * 18, 24 - Math.cos(r) * 18, a, k)} fill={color} strokeLinejoin="round" stroke={color} strokeWidth={1.5} />;
}
function uturnArrow(color: string, sw: number, key?: string): ReactNode[] {
  return [
    <Path key={`${key ?? 'u'}s`} d="M31 44V20a7 7 0 00-14 0v10" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" />,
    <Path key={`${key ?? 'u'}h`} d={head(17, 34, 180)} fill={color} />,
  ];
}

/** Vector maneuver arrows: curved stem + head, U-turn, roundabout (with exit number), ramps/forks (ghost through-road, side kept) and arrival pin. */
export function ManeuverIcon({ type, modifier, exit, size = 56, color = '#fff' }: { type: ManeuverType; modifier?: ManeuverModifier | undefined; exit?: number | undefined; size?: number; color?: string }) {
  const m = modifier ?? 'straight';
  const sw = 5.5;
  let body: ReactNode;
  let kind: 'turn' | 'ramp' | 'uturn' | 'roundabout' | 'arrive';
  let kindAngle = 0;
  if (type === 'arrive') {
    kind = 'arrive';
    body = (
      <>
        <Path d="M24 4c-7.7 0-13 5.6-13 12.8C11 26.4 24 42 24 42s13-15.6 13-25.2C37 9.6 31.7 4 24 4z" fill={color} />
        <Circle cx={24} cy={17} r={5} fill="rgba(0,0,0,0.35)" />
      </>
    );
  } else if (m === 'uturn') {
    kind = 'uturn';
    body = <>{uturnArrow(color, sw)}</>;
  } else if (ROUNDABOUTS.has(type)) {
    const a = ANGLE[m] ?? 0;
    kind = 'roundabout';
    kindAngle = a;
    const r = (a * Math.PI) / 180;
    const ex = 24 + Math.sin(r) * 18;
    const ey = 22 - Math.cos(r) * 18;
    body = (
      <>
        <Circle cx={24} cy={22} r={8} stroke={color} strokeOpacity={0.45} strokeWidth={4} fill="none" />
        <Path d={`M24 44V30 M${(24 + Math.sin(r) * 8).toFixed(2)} ${(22 - Math.cos(r) * 8).toFixed(2)} L${ex.toFixed(2)} ${ey.toFixed(2)}`} stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" />
        <Path d={head(24 + Math.sin(r) * 20, 22 - Math.cos(r) * 20, a)} fill={color} />
        {exit !== undefined && (
          <SvgText x={24} y={26} fontSize={11} fontWeight="900" fill={color} textAnchor="middle">
            {String(exit)}
          </SvgText>
        )}
      </>
    );
  } else {
    const ramp = RAMPS.has(type);
    // Ramps/forks: clamp the bend but keep the side, so a right fork never reads as straight.
    let a = ANGLE[m] ?? 0;
    if (ramp && a !== 0) a = Math.sign(a) * Math.min(60, Math.max(35, Math.abs(a)));
    kind = ramp ? 'ramp' : 'turn';
    kindAngle = a;
    body = (
      <>
        {ramp && a !== 0 && <Path d="M24 44V6" stroke={color} strokeOpacity={0.3} strokeWidth={sw} strokeLinecap="round" />}
        {turnArrow(a, color, sw)}
        {turnHead(a, color)}
      </>
    );
  }
  // Centre the drawn extents in the viewBox (a G transform, not nested Svg offsets).
  const b = glyphBounds(kind, kindAngle);
  const dx = 24 - (b.minX + b.maxX) / 2;
  const dy = 24 - (b.minY + b.maxY) / 2;
  return (
    <Svg width={size} height={size} viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`}>
      <G transform={`translate(${dx.toFixed(2)} ${dy.toFixed(2)})`}>{body}</G>
    </Svg>
  );
}

const ON = '#fff';
const DIM = 'rgba(255,255,255,0.34)';
const OFF = 'rgba(255,255,255,0.2)';

/** Lane strip drawn as one mini road: solid road edges, dashed lane separators, allowed movements per lane (route movement bright, others dimmed). */
function Lanes({ lanes, modifier, compact, h }: { lanes: Lane[]; modifier: ManeuverModifier | undefined; compact?: boolean; h: number }) {
  const [w, setW] = useState(0);
  const lay = laneStripLayout(lanes.length, w || 120, h, compact);
  const { dashed, edges } = laneDividers(lanes.length);
  const hotW = strokeUnits('hot', lay.scale);
  const dimW = strokeUnits('dim', lay.scale);
  const edgeW = strokeUnits('edge', lay.scale);
  return (
    <View style={[styles.lanes, { height: h }]} accessibilityLabel="lanes" testID="nav-lanes" onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <Svg width={lay.width} height={lay.height} viewBox={`0 0 ${lay.units.w} ${lay.units.h}`}>
        <Rect x={0} y={0} width={lay.units.w} height={lay.units.h} rx={4} fill="rgba(0,0,0,0.3)" />
        {lanes.map((l, i) => {
          const s = laneShape(l, matchingIndication(l, modifier));
          const hotLane = l.valid;
          return (
            <G key={i} transform={`translate(${i * CELL.w} 0)`}>
              {hotLane && <Rect x={1} y={0} width={CELL.w - 2} height={CELL.h} fill="rgba(255,255,255,0.16)" />}
              <Path d={s.stem} stroke={s.stemHot ? ON : hotLane ? DIM : OFF} strokeWidth={s.stemHot ? hotW : dimW} strokeLinecap="round" fill="none" />
              {s.arrows.map((a) => {
                const c = a.hot ? ON : hotLane ? DIM : OFF;
                const sw = a.hot ? hotW : dimW;
                return (
                  <G key={a.dir}>
                    {a.taper && <Path d={a.taper} stroke={hotLane ? DIM : OFF} strokeWidth={dimW} strokeLinecap="round" fill="none" />}
                    <Path d={a.line} stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    <Path d={a.head} fill={c} stroke={c} strokeWidth={1} strokeLinejoin="round" />
                  </G>
                );
              })}
              {s.turnOnly && <Path d={`M${CELL.w / 2 - 6} 5 H${CELL.w / 2 + 6}`} stroke={hotLane ? ON : OFF} strokeWidth={dimW} strokeLinecap="round" />}
              {s.yourLane && <Path d={`M${CELL.w / 2 - 5} 49 L${CELL.w / 2} 45 L${CELL.w / 2 + 5} 49`} stroke={ON} strokeWidth={dimW} strokeLinecap="round" strokeLinejoin="round" fill="none" />}
            </G>
          );
        })}
        {dashed.map((x) => (
          <Path key={x} d={`M${x} 3 V${CELL.h - 3}`} stroke="rgba(255,255,255,0.5)" strokeWidth={edgeW} strokeDasharray="5 4" fill="none" />
        ))}
        {edges.map((x) => (
          <Path key={x} d={`M${x} 0 V${CELL.h}`} stroke="rgba(255,255,255,0.85)" strokeWidth={edgeW * 1.4} fill="none" />
        ))}
      </Svg>
    </View>
  );
}

/** Right-hand column: the lane strip, as tall as the banner row allows. */
function InfoColumn({ lanes, modifier, compact }: { lanes: Lane[]; modifier: ManeuverModifier | undefined; compact: boolean }) {
  const rowH = compact ? 60 : 84;
  return (
    <View style={[styles.info, { height: rowH }]} testID="nav-info">
      <Lanes lanes={lanes} modifier={modifier} compact={compact} h={rowH} />
    </View>
  );
}

/** Fixed time-to-turn line along the banner's bottom edge: track + fill = approach, label at the right end. Space is always reserved. */
function TimeLine({ distanceM, compact }: { distanceM: number; compact: boolean }) {
  const speed = useApp((s) => s.fix?.speed ?? null);
  const start = useRef(distanceM);
  if (distanceM > start.current) start.current = distanceM;
  const secs = timeToTurnS(distanceM, speed);
  const d = secs == null ? null : splitDuration(secs);
  const prog = approachProgress(distanceM, start.current);
  return (
    <View style={[styles.timeLine, compact && styles.timeLineC]} testID="nav-time">
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.round(prog * 100)}%` }]} />
      </View>
      <Text style={[styles.timeLabel, { opacity: d ? 1 : 0 }]} numberOfLines={1}>
        {d ? t(d.unit === 'sec' ? 'nav.sec' : 'nav.min', { n: d.n }) : t('nav.sec', { n: 0 })}
      </Text>
    </View>
  );
}

function BannerBg({ id, from, to }: { id: string; from: string; to: string }) {
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </LinearGradient>
      </Defs>
      <Rect width={100} height={100} fill={`url(#${id})`} />
    </Svg>
  );
}

const PROMOTE_MS = 350;

/** New main banner rises out of the "then" slot below and grows into place. */
const promoteIn: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    initialValues: { opacity: 0.4, transform: [{ translateY: 64 }, { scale: 0.62 }] },
    animations: {
      opacity: withTiming(1, { duration: PROMOTE_MS }),
      transform: [{ translateY: withTiming(0, { duration: PROMOTE_MS }) }, { scale: withTiming(1, { duration: PROMOTE_MS }) }],
    },
  };
};

/**
 * F11: main banner = next maneuver (arrow, distance, road name/shield/exit; right column: lanes, time to turn, approach bar); directly under it a smaller
 * dark tab = the maneuver after it with the distance from here, emphasised (bigger, bolder; still black) when close.
 * Both are keyed by step index, so they only animate when the route step actually changes (never on GPS jitter).
 */
export function NavBanners({ p, onLayout, compact = false }: { p: ProgressState; onLayout?: (r: LayoutRectangle) => void; compact?: boolean }) {
  const next = p.next;
  const fol = p.following;
  if (!next) return null;
  const emph = fol?.emphasized ?? false;
  const banner = next.banner;
  const comps = banner?.primary.components ?? [];
  const road = banner?.primary.text || next.step.name || next.step.ref || '';
  const shield = comps.find((c) => c.type === 'icon')?.text ?? next.step.ref;
  const exitNo = comps.find((c) => c.type === 'exit-number')?.text;
  const type = banner?.primary.type ?? next.step.maneuver.type;
  const modifier = banner?.primary.modifier ?? next.step.maneuver.modifier;
  // Owner preference: the following-turn box is always black; close turns are emphasised by size only.
  const ink = '#fff';
  const folType = fol ? (fol.banner?.primary.type ?? fol.step.maneuver.type) : null;
  const folRoad = fol ? (folType === 'arrive' ? '' : fol.banner?.primary.text || fol.step.name || fol.step.ref || '') : '';
  return (
    <View onLayout={(e) => onLayout?.(e.nativeEvent.layout)} pointerEvents="none">
      <Animated.View key={`m${next.step.index}`} entering={promoteIn} exiting={FadeOutUp.duration(PROMOTE_MS)} style={[styles.main, styles.shadow, compact && styles.mainC]} testID="nav-main-banner">
        <BannerBg id="nav-main" from="#14935C" to="#0A6B41" />
        <View style={styles.topRow}>
        <View style={[styles.iconBox, compact && styles.iconBoxC]}>
          <ManeuverIcon type={type} modifier={modifier} exit={next.step.maneuver.exit} size={compact ? 50 : 72} />
        </View>
        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
          <Text style={[styles.dist, compact && styles.distC]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{formatNavDistance(next.distanceM, lang())}</Text>
          <View style={styles.roadRow}>
            {exitNo ? (
              <View style={styles.exit}>
                <Text style={styles.exitText}>{exitNo}</Text>
              </View>
            ) : null}
            {shield ? (
              <View style={styles.shield}>
                <Text style={styles.shieldText}>{shield}</Text>
              </View>
            ) : null}
            <Text style={[styles.road, compact && styles.roadC]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {road}
            </Text>
          </View>
        </View>
        {next.lanes ? <InfoColumn lanes={next.lanes} modifier={modifier} compact={compact} /> : null}
        </View>
        <TimeLine distanceM={next.distanceM} compact={compact} />
      </Animated.View>
      {fol && folType && (
        <Animated.View
          key={`f${fol.step.index}`}
          entering={FadeInDown.delay(PROMOTE_MS / 2).duration(PROMOTE_MS)}
          style={[styles.followOuter, compact && styles.followOuterC]}
        >
        <View
          style={[styles.follow, styles.shadow, compact && styles.followC, emph && styles.followEmph]}
          testID="nav-following-tab"
          accessibilityLabel={`${t('nav.then')} ${fol.banner?.primary.text ?? ''}`}
        >
          <Text style={[styles.then, { color: emph ? ink : 'rgba(255,255,255,0.7)', fontWeight: emph ? '800' : undefined }]}>{t('nav.then')}</Text>
          <ManeuverIcon
            type={folType}
            modifier={fol.banner?.primary.modifier ?? fol.step.maneuver.modifier}
            exit={fol.step.maneuver.exit}
            size={compact ? 26 : emph ? 38 : 32}
            color={ink}
          />
          {folRoad ? (
            <Text style={[styles.followRoad, { color: ink }]} numberOfLines={1}>
              {folRoad}
            </Text>
          ) : null}
          <Text style={[styles.followDist, { color: ink }]}>{formatNavDistance(fol.distanceM, lang())}</Text>
        </View>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: { shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 10 },
  main: { gap: 6, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 14, marginHorizontal: 10, overflow: 'hidden' },
  mainC: { gap: 4, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 16 },
  iconBoxC: { width: 52, height: 52, borderRadius: 12 },
  distC: { fontSize: 26 },
  roadC: { fontSize: 15 },
  followOuterC: { marginLeft: 14, maxWidth: '92%' },
  followC: { gap: 6, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6 },
  iconBox: { width: 72, height: 72, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.16)', alignItems: 'center', justifyContent: 'center' },
  dist: { color: '#fff', fontSize: 34, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  roadRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  road: { color: '#EFFFF6', fontSize: 19, fontWeight: '700', flexShrink: 1 },
  shield: { backgroundColor: '#fff', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, borderWidth: 1.5, borderColor: '#0A6B41' },
  shieldText: { color: '#0A6B41', fontWeight: '900', fontSize: 15, fontVariant: ['tabular-nums'] },
  exit: { backgroundColor: '#FFD466', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  exitText: { color: '#2A1A00', fontWeight: '900', fontSize: 15, fontVariant: ['tabular-nums'] },
  info: { width: '48%', justifyContent: 'center' },
  lanes: { alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  timeLine: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 16, marginHorizontal: 4, marginTop: 2 },
  timeLineC: { height: 14, marginTop: 0 },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.25)', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.9)' },
  timeLabel: { color: '#fff', fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'], minWidth: 40, textAlign: 'right' },
  followOuter: { alignSelf: 'flex-start', maxWidth: '85%', marginLeft: 24, marginTop: -4 },
  follow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
    overflow: 'hidden',
    backgroundColor: '#111614',
  },
  followEmph: { transform: [{ scale: 1.06 }] },
  then: { fontWeight: '700', fontSize: 15 },
  followRoad: { fontWeight: '700', fontSize: 15, flexShrink: 1 },
  followDist: { fontWeight: '800', fontSize: 15, fontVariant: ['tabular-nums'] },
});
