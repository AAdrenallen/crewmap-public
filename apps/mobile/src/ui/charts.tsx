import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { useTheme } from './theme';
import type { SpeedSample } from '@crewmap/shared/driving';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export function scoreColor(score: number): string {
  if (score >= 90) return '#30A46C';
  if (score >= 75) return '#5B6CFF';
  if (score >= 60) return '#FFB224';
  return '#E5484D';
}

/** Speed → route colour (trip detail). */
export function speedColor(kph: number, limit: number | null): string {
  if (limit !== null && kph > limit + 10) return '#E5484D';
  if (limit !== null && kph > limit) return '#FFB224';
  if (kph < 30) return '#7DD3FC';
  if (kph < 70) return '#5B6CFF';
  return '#3C46C9';
}

/** Smooth cubic path through points (Catmull-Rom style tension). */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  let d = `M${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const k = 0.18;
    d += ` C${p1.x + (p2.x - p0.x) * k} ${p1.y + (p2.y - p0.y) * k} ${p2.x - (p3.x - p1.x) * k} ${p2.y - (p3.y - p1.y) * k} ${p2.x} ${p2.y}`;
  }
  return d;
}

/** Animated gradient score gauge (270° arc). */
export function ScoreRing({ score, size = 132, label }: { score: number | null; size?: number; label?: string }) {
  const th = useTheme();
  const stroke = Math.max(8, size * 0.09);
  const r = size / 2 - stroke / 2 - 2;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75;
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withTiming(score === null ? 0 : score / 100, { duration: 900, easing: Easing.out(Easing.cubic) });
  }, [score, p]);
  const props = useAnimatedProps(() => ({ strokeDasharray: [Math.max(0.01, arc * p.value), c] }));
  const col = score === null ? th.border : scoreColor(score);
  const id = `ring${Math.round(size)}`;
  const mid = size / 2;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={`score ${score ?? ''}`}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="1" x2="1" y2="0">
            <Stop offset="0" stopColor={col} stopOpacity={0.6} />
            <Stop offset="1" stopColor={col} />
          </LinearGradient>
        </Defs>
        <G rotation={135} origin={`${mid}, ${mid}`}>
          <Circle cx={mid} cy={mid} r={r} stroke={th.cardAlt} strokeWidth={stroke} strokeLinecap="round" fill="none" strokeDasharray={[arc, c]} />
          {score !== null && <AnimatedCircle cx={mid} cy={mid} r={r} stroke={`url(#${id})`} strokeWidth={stroke} strokeLinecap="round" fill="none" animatedProps={props} />}
        </G>
      </Svg>
      <Text style={{ fontSize: size * 0.3, fontWeight: '800', color: th.text, fontVariant: ['tabular-nums'], letterSpacing: -1 }} testID="score-value">
        {score ?? '—'}
      </Text>
      {label !== undefined && (
        <Text style={{ position: 'absolute', bottom: size * 0.06, fontSize: Math.max(10, size * 0.09), fontWeight: '700', color: th.textSoft }} numberOfLines={1}>
          {label}
        </Text>
      )}
    </View>
  );
}

/** Score trend: smooth gradient area (nulls = gaps) over rounded distance bars, with labelled gridlines. */
export function TrendChart({ points, width, height = 160 }: { points: { score: number | null; km: number }[]; width: number; height?: number }) {
  const th = useTheme();
  const left = 26;
  const right = 12;
  const top = 18;
  const barH = 24;
  const plotB = height - barH - 12;
  const n = Math.max(1, points.length - 1);
  const x = (i: number) => left + (points.length === 1 ? 0.5 : i / n) * (width - left - right);
  const y = (s: number) => top + (1 - (Math.max(40, s) - 40) / 60) * (plotB - top);
  const maxKm = Math.max(1, ...points.map((p) => p.km));
  const runs: { x: number; y: number }[][] = [];
  points.forEach((p, i) => {
    if (p.score === null) return;
    if (i === 0 || points[i - 1]!.score === null) runs.push([]);
    runs[runs.length - 1]!.push({ x: x(i), y: y(p.score) });
  });
  let lastI = -1;
  points.forEach((p, i) => {
    if (p.score !== null) lastI = i;
  });
  const lastScore = lastI >= 0 ? points[lastI]!.score : null;
  const bw = Math.max(4, Math.min(14, ((width - left - right) / Math.max(1, points.length)) * 0.55));
  return (
    <Svg width={width} height={height} accessibilityLabel="score trend">
      <Defs>
        <LinearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={th.accent} stopOpacity={0.32} />
          <Stop offset="1" stopColor={th.accent} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      {[60, 80, 100].map((g) => (
        <G key={g}>
          <Line x1={left} x2={width - right} y1={y(g)} y2={y(g)} stroke={th.border} strokeWidth={1} strokeDasharray="2 5" />
          <SvgText x={left - 6} y={y(g) + 4} fill={th.textSoft} fontSize={10} fontWeight="600" textAnchor="end">
            {g}
          </SvgText>
        </G>
      ))}
      {points.map((p, i) => {
        const h = p.km > 0 ? Math.max(3, (p.km / maxKm) * barH) : 0;
        return <Rect key={`b${i}`} x={x(i) - bw / 2} width={bw} y={height - 4 - h} height={h} rx={Math.min(bw / 2, 4)} fill={th.accent} fillOpacity={0.25} />;
      })}
      {runs.map((run, k) => {
        const d = smoothPath(run);
        const area = run.length > 1 ? `${d} L${run[run.length - 1]!.x} ${plotB} L${run[0]!.x} ${plotB} Z` : '';
        return (
          <G key={k}>
            {area !== '' && <Path d={area} fill="url(#trendFill)" />}
            <Path d={d} stroke={th.accent} strokeWidth={3} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          </G>
        );
      })}
      {lastScore !== null && (
        <G>
          <Circle cx={x(lastI)} cy={y(lastScore)} r={6} fill={th.card} stroke={scoreColor(lastScore)} strokeWidth={3} />
          <SvgText x={Math.min(Math.max(x(lastI), left + 10), width - right - 10)} y={Math.max(11, y(lastScore) - 12)} fill={th.text} fontSize={12} fontWeight="800" textAnchor="middle">
            {lastScore}
          </SvgText>
        </G>
      )}
    </Svg>
  );
}

/** Horizontal bars with rounded tracks, optional leading icon and per-row colour. */
export function Bars({ rows }: { rows: { label: string; value: number; color?: string; icon?: ReactNode }[] }) {
  const th = useTheme();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <View style={{ gap: 14 }}>
      {rows.map((r) => (
        <View key={r.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {r.icon}
          <View style={{ flex: 1, gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={{ flex: 1, color: th.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                {r.label}
              </Text>
              <Text style={{ color: r.value ? th.text : th.textSoft, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{r.value}</Text>
            </View>
            <View style={{ height: 8, backgroundColor: th.cardAlt, borderRadius: 4, overflow: 'hidden' }}>
              <View style={{ width: `${(r.value / max) * 100}%`, height: '100%', backgroundColor: r.color ?? '#FF6B6B', borderRadius: 4 }} />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

/** Mini route thumbnail: the stored polyline projected into a box (no map tiles, no billing). */
export function RouteThumb({ points, size = 56, color }: { points: { lat: number; lng: number }[]; size?: number; color: string }) {
  const th = useTheme();
  if (points.length < 2) return <View style={{ width: size, height: size, borderRadius: 14, backgroundColor: th.cardAlt }} />;
  const step = Math.max(1, Math.floor(points.length / 80));
  const pts = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const k = Math.cos((pts[0]!.lat * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * k);
  const ys = pts.map((p) => -p.lat);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 1e-6);
  const pad = 8;
  const s = (size - pad * 2) / span;
  const ox = pad + (size - pad * 2 - (Math.max(...xs) - minX) * s) / 2;
  const oy = pad + (size - pad * 2 - (Math.max(...ys) - minY) * s) / 2;
  const P = pts.map((_, i) => ({ x: ox + (xs[i]! - minX) * s, y: oy + (ys[i]! - minY) * s }));
  const d = P.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return (
    <Svg width={size} height={size}>
      <Rect width={size} height={size} rx={14} fill={th.cardAlt} />
      <Path d={d} stroke={color} strokeOpacity={0.25} strokeWidth={6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <Path d={d} stroke={color} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={P[0]!.x} cy={P[0]!.y} r={3} fill={th.card} stroke={color} strokeWidth={2} />
      <Circle cx={P[P.length - 1]!.x} cy={P[P.length - 1]!.y} r={3.5} fill={color} />
    </Svg>
  );
}

/** Horizontal drag/tap surface reporting a 0..1 fraction. */
function useFractionResponder(onFraction: (f: number) => void, onStart?: () => void) {
  const w = useRef(1);
  const cb = useRef({ onFraction, onStart });
  cb.current = { onFraction, onStart };
  const pan = useMemo(() => {
    const at = (x: number) => cb.current.onFraction(Math.max(0, Math.min(1, x / w.current)));
    // Horizontal scrub only: a vertical drag fails it, so the screen keeps scrolling.
    const drag = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetX([-4, 4])
      .failOffsetY([-10, 10])
      .onStart((e) => {
        cb.current.onStart?.();
        at(e.x);
      })
      .onUpdate((e) => at(e.x));
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((e) => {
        cb.current.onStart?.();
        at(e.x);
      });
    return Gesture.Exclusive(drag, tap);
  }, []);
  return { pan, setWidth: (x: number) => (w.current = Math.max(1, x)) };
}

/** Slider: 0..1 value with a draggable thumb (replay scrubber). */
export function Scrubber({ value, onChange, onStart, label, testID }: { value: number; onChange: (f: number) => void; onStart?: () => void; label: string; testID?: string }) {
  const th = useTheme();
  const [w, setW] = useState(1);
  const { pan, setWidth } = useFractionResponder(onChange, onStart);
  const v = Math.max(0, Math.min(1, value));
  return (
    <GestureDetector gesture={pan}>
    <View
      testID={testID}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onChange(Math.max(0, Math.min(1, v + (e.nativeEvent.actionName === 'increment' ? 0.05 : -0.05))))}
      onLayout={(e) => {
        setW(e.nativeEvent.layout.width);
        setWidth(e.nativeEvent.layout.width);
      }}
      style={{ height: 40, justifyContent: 'center' }}
    >
      <View pointerEvents="none" style={{ height: 6, borderRadius: 3, backgroundColor: th.border }}>
        <View style={{ width: v * w, height: 6, borderRadius: 3, backgroundColor: th.accent }} />
      </View>
      <View pointerEvents="none" style={{ position: 'absolute', left: v * w - 11, width: 22, height: 22, borderRadius: 11, backgroundColor: th.accent, borderWidth: 3, borderColor: th.card }} />
    </View>
    </GestureDetector>
  );
}

/** Speed over distance, coloured by speeding, with a cursor that can be dragged to scrub. */
export function SpeedChart({ samples, width, height = 130, cursorD, onScrub, unit }: { samples: SpeedSample[]; width: number; height?: number; cursorD?: number | null; onScrub?: (d: number) => void; unit: string }) {
  const th = useTheme();
  const total = samples.length > 0 ? samples[samples.length - 1]!.d : 0;
  const { pan, setWidth } = useFractionResponder((f) => onScrub?.(f * total));
  setWidth(width);
  const view = useMemo(() => {
    const step = Math.max(1, Math.floor(samples.length / 160));
    return samples.filter((_, i) => i % step === 0 || i === samples.length - 1);
  }, [samples]);
  if (view.length < 2 || total <= 0) return null;
  const left = 30;
  const top = 8;
  const bottom = 6;
  const maxK = Math.max(20, ...view.map((s) => Math.max(s.kph, s.limitKph ?? 0)));
  const top10 = Math.ceil(maxK / 20) * 20;
  const x = (d: number) => left + (d / total) * (width - left - 4);
  const y = (k: number) => top + (1 - k / top10) * (height - top - bottom);
  const limitD = view
    .filter((s) => s.limitKph !== null)
    .map((s, i) => `${i ? 'L' : 'M'}${x(s.d).toFixed(1)} ${y(s.limitKph!).toFixed(1)}`)
    .join(' ');
  const cx = cursorD === null || cursorD === undefined ? null : x(Math.max(0, Math.min(total, cursorD)));
  return (
    <GestureDetector gesture={pan}>
    <View style={{ width, height }} accessibilityLabel={unit}>
      <Svg width={width} height={height} pointerEvents="none">
        {[0, top10 / 2, top10].map((g) => (
          <G key={g}>
            <Line x1={left} x2={width - 4} y1={y(g)} y2={y(g)} stroke={th.border} strokeWidth={1} strokeDasharray="2 5" />
            <SvgText x={left - 6} y={y(g) + 4} fill={th.textSoft} fontSize={10} fontWeight="600" textAnchor="end">
              {Math.round(g)}
            </SvgText>
          </G>
        ))}
        {limitD !== '' && <Path d={limitD} stroke={th.textSoft} strokeWidth={1.5} strokeDasharray="4 3" fill="none" />}
        {view.slice(1).map((s, i) => {
          const a = view[i]!;
          return <Line key={i} x1={x(a.d)} y1={y(a.kph)} x2={x(s.d)} y2={y(s.kph)} stroke={speedColor(s.kph, s.limitKph)} strokeWidth={2.5} strokeLinecap="round" />;
        })}
        {cx !== null && <Line x1={cx} x2={cx} y1={top} y2={height - bottom} stroke={th.text} strokeWidth={1.5} />}
      </Svg>
    </View>
    </GestureDetector>
  );
}

/** Play / pause / overflow glyphs (not in the icon set). */
export function Glyph({ kind, color, size = 22 }: { kind: 'play' | 'pause' | 'more'; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {kind === 'play' && <Path d="M7 4.5v15l12-7.5z" fill={color} />}
      {kind === 'pause' && (
        <>
          <Rect x={6} y={4.5} width={4} height={15} rx={1} fill={color} />
          <Rect x={14} y={4.5} width={4} height={15} rx={1} fill={color} />
        </>
      )}
      {kind === 'more' && (
        <>
          <Circle cx={12} cy={5} r={2} fill={color} />
          <Circle cx={12} cy={12} r={2} fill={color} />
          <Circle cx={12} cy={19} r={2} fill={color} />
        </>
      )}
    </Svg>
  );
}

/** BCP-47 locale for date formatting from the app language. */
export function dateLocale(l: 'en' | 'fr' | 'ru'): string {
  return l === 'fr' ? 'fr-CA' : l === 'ru' ? 'ru-RU' : 'en-CA';
}
