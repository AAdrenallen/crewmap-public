import { Pressable } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';
import type { Bucket } from '@crewmap/shared/stats';
import { useTheme } from '../theme';

/** Bars per bucket with the previous period as ghost bars behind; tap a bar to select it. */
export function MetricChart({
  buckets,
  previous,
  color,
  width,
  height = 180,
  selected,
  onSelect,
  label,
}: {
  buckets: Bucket[];
  previous: Bucket[];
  color: string;
  width: number;
  height?: number;
  selected: number | null;
  onSelect: (i: number | null) => void;
  label: (b: Bucket, i: number) => string;
}) {
  const th = useTheme();
  const left = 8;
  const right = 8;
  const top = 10;
  const axis = 22;
  const plotB = height - axis;
  const n = Math.max(1, buckets.length);
  const slot = (width - left - right) / n;
  const bw = Math.max(2, Math.min(28, slot * 0.62));
  const max = Math.max(1, ...buckets.map((b) => b.value ?? 0), ...previous.slice(0, n).map((b) => b.value ?? 0));
  const h = (v: number | null) => (v === null || v <= 0 ? 0 : Math.max(3, (v / max) * (plotB - top)));
  const every = Math.max(1, Math.ceil(n / 7));
  return (
    <Pressable
      accessibilityRole="image"
      onPress={(e) => {
        const i = Math.floor((e.nativeEvent.locationX - left) / slot);
        onSelect(i >= 0 && i < n && !buckets[i]!.future && i !== selected ? i : null);
      }}
    >
      <Svg width={width} height={height}>
        <Line x1={left} x2={width - right} y1={plotB} y2={plotB} stroke={th.border} strokeWidth={1} />
        {buckets.map((b, i) => {
          const cx = left + slot * (i + 0.5);
          const ph = h(previous[i]?.value ?? null);
          const bh = h(b.value);
          return (
            <G key={b.start}>
              {ph > 0 && <Rect x={cx - bw / 2} y={plotB - ph} width={bw} height={ph} rx={Math.min(bw / 2, 4)} fill={th.textFaint} fillOpacity={0.25} />}
              {bh > 0 && <Rect x={cx - bw / 2 + bw * 0.12} y={plotB - bh} width={bw * 0.76} height={bh} rx={Math.min(bw / 2, 4)} fill={color} fillOpacity={selected === null || selected === i ? 1 : 0.4} />}
              {i % every === 0 && (
                <SvgText x={cx} y={height - 6} fill={selected === i ? th.text : th.textSoft} fontSize={10} fontWeight="600" textAnchor="middle">
                  {label(b, i)}
                </SvgText>
              )}
            </G>
          );
        })}
      </Svg>
    </Pressable>
  );
}
