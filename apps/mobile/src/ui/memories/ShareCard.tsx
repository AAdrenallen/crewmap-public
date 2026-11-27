import { forwardRef, useImperativeHandle, useRef } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { File, Paths } from 'expo-file-system';
import { CARD, projectLines, type Highlight, type TrackPt } from '@crewmap/shared/memories';
import { t } from '@crewmap/shared/i18n';
import { palette } from '../theme';
import { hlLabel, hlValue } from './memoryUi';

export interface ShareCardHandle {
  /** Renders the card to a PNG in the cache dir; null when the renderer fails. */
  capture(): Promise<string | null>;
}

/**
 * The shareable recap image (D68), drawn with react-native-svg (already in the app) and rasterised by its toDataURL.
 * It leaves the crew, so it carries only my own route and numbers, crewmates as initials, and no photos.
 */
export const ShareCard = forwardRef<ShareCardHandle, { title: string; date: string; route: TrackPt[]; highlights: Highlight[]; initials: string[]; emoji: string[] }>(function ShareCard(
  { title, date, route, highlights, initials, emoji },
  ref,
) {
  const svg = useRef<Svg>(null);
  useImperativeHandle(ref, () => ({
    capture: () =>
      new Promise<string | null>((resolve) => {
        const s = svg.current as unknown as { toDataURL?: (cb: (b64: string) => void, o?: object) => void } | null;
        if (!s?.toDataURL) return resolve(null);
        const timer = setTimeout(() => resolve(null), 8000);
        s.toDataURL(
          (b64) => {
            clearTimeout(timer);
            try {
              const f = new File(Paths.cache, `crewmap-recap-${Date.now()}.png`);
              f.create({ overwrite: true });
              f.write(b64, { encoding: 'base64' });
              resolve(f.uri);
            } catch {
              resolve(null);
            }
          },
          { width: CARD.w, height: CARD.h },
        );
      }),
  }));
  const [path] = projectLines([route], { x: CARD.pad, y: CARD.mapTop, w: CARD.w - 2 * CARD.pad, h: CARD.mapH });
  const tiles = highlights.filter((h) => !h.who).slice(0, 3);
  const tileW = (CARD.w - 2 * CARD.pad - 2 * 24) / 3;
  return (
    // Laid out off-screen at a quarter size; the raster is full size.
    <View pointerEvents="none" style={{ position: 'absolute', left: -10_000, top: 0, width: CARD.w / 4, height: CARD.h / 4 }} importantForAccessibility="no-hide-descendants">
      <Svg ref={svg} width={CARD.w / 4} height={CARD.h / 4} viewBox={`0 0 ${CARD.w} ${CARD.h}`}>
        <Defs>
          <LinearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={palette.brand} />
            <Stop offset="1" stopColor={palette.ink} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={CARD.w} height={CARD.h} fill="url(#bg)" />
        <SvgText x={CARD.pad} y={150} fill="#FFFFFF" fontSize={64} fontWeight="800">
          {title.length > 26 ? `${title.slice(0, 25)}…` : title}
        </SvgText>
        <SvgText x={CARD.pad} y={215} fill="rgba(255,255,255,0.75)" fontSize={36} fontWeight="600">
          {date}
        </SvgText>
        <Rect x={CARD.pad - 30} y={CARD.mapTop - 30} width={CARD.w - 2 * CARD.pad + 60} height={CARD.mapH + 60} rx={48} fill="rgba(255,255,255,0.08)" />
        {path ? (
          <>
            <Path d={path} stroke="rgba(255,255,255,0.35)" strokeWidth={26} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <Path d={path} stroke={palette.sun} strokeWidth={12} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : null}
        {tiles.map((h, i) => (
          <SvgText key={`v${h.kind}`} x={CARD.pad + i * (tileW + 24)} y={1060} fill="#FFFFFF" fontSize={52} fontWeight="800">
            {hlValue(h)}
          </SvgText>
        ))}
        {tiles.map((h, i) => (
          <SvgText key={`l${h.kind}`} x={CARD.pad + i * (tileW + 24)} y={1110} fill="rgba(255,255,255,0.7)" fontSize={30} fontWeight="600">
            {hlLabel(h, null)}
          </SvgText>
        ))}
        {initials.slice(0, 7).map((s, i) => (
          <Circle key={`c${i}`} cx={CARD.pad + 40 + i * 70} cy={1220} r={36} fill={['#FF5A6A', '#14B8A6', '#FFC233', '#8E44AD', '#FB8C00', '#2EC4B6', '#E5484D'][i % 7]} stroke="#FFFFFF" strokeWidth={5} />
        ))}
        {initials.slice(0, 7).map((s, i) => (
          <SvgText key={`i${i}`} x={CARD.pad + 40 + i * 70} y={1233} fill="#FFFFFF" fontSize={34} fontWeight="800" textAnchor="middle">
            {s}
          </SvgText>
        ))}
        <SvgText x={CARD.w - CARD.pad} y={1235} fill="#FFFFFF" fontSize={44} textAnchor="end">
          {emoji.slice(0, 4).join(' ')}
        </SvgText>
        <SvgText x={CARD.w - CARD.pad} y={1310} fill="rgba(255,255,255,0.55)" fontSize={28} fontWeight="700" textAnchor="end">
          {t('appName')}
        </SvgText>
      </Svg>
    </View>
  );
});
