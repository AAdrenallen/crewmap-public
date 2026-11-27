import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeOutUp, ZoomIn } from 'react-native-reanimated';
import { Camera, LineLayer, MapView, MarkerView, ShapeSource } from '@rnmapbox/maps';
import { bboxOf } from '@crewmap/shared/geo';
import { playbackClock, posesAt, type PlaybackTrack, type TimelineItem } from '@crewmap/shared/memories';
import { formatClock } from '@crewmap/shared/units';
import { t } from '@crewmap/shared/i18n';
import { platform } from '@crewmap/platform';
import { onMapboxLoadingError } from '../../core/errorLog';
import { Bouncy, Chip } from '../kit';
import { Glyph, Scrubber } from '../charts';
import { MapSprite } from '../map/Sprites';
import { useReduceMotion } from '../useReduceMotion';
import { font, type, useTheme } from '../theme';
import { colorAt, emojiOf, type Person } from './memoryUi';

const RATES = [1, 2] as const;
const FRAME_MS = 50;
const BUBBLE_MS = 1400;

/**
 * Animated route playback (D68): every member's ride moves along their track on one compressed clock (stops collapse
 * to a beat), trails grow behind them, and emotes pop above the sender when the clock passes them.
 */
export function PlaybackMap({ tracks, people, timeline, height = 340 }: { tracks: PlaybackTrack[]; people: Record<string, Person>; timeline: TimelineItem[]; height?: number }) {
  const th = useTheme();
  const reduce = useReduceMotion();
  const clock = useMemo(() => playbackClock(tracks), [tracks]);
  const [play, setPlay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);
  const last = useRef(0);
  const started = useRef(false);

  // Autoplay once when the recap opens (not with reduced motion: the end state shows instead).
  useEffect(() => {
    if (started.current || clock.durationMs === 0) return;
    started.current = true;
    if (reduce) setPlay(clock.durationMs);
    else setPlaying(true);
  }, [clock, reduce]);

  useEffect(() => {
    if (!playing) return;
    last.current = Date.now();
    const h = setInterval(() => {
      const now = Date.now();
      const dt = (now - last.current) * rate;
      last.current = now;
      setPlay((p) => {
        const n = p + dt;
        if (n >= clock.durationMs) {
          setPlaying(false);
          platform.haptics.play('success');
          return clock.durationMs;
        }
        return n;
      });
    }, FRAME_MS);
    return () => clearInterval(h);
  }, [playing, rate, clock]);

  const realT = clock.realAt(play);
  const poses = useMemo(() => posesAt(tracks, realT), [tracks, realT]);
  const colorOf = useMemo(() => Object.fromEntries(tracks.map((tr, i) => [tr.who, colorAt(i)])), [tracks]);

  const full = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: tracks.map((tr) => ({ type: 'Feature' as const, properties: { color: colorOf[tr.who] }, geometry: { type: 'LineString' as const, coordinates: tr.pts.map((p) => [p.lng, p.lat]) } })),
    }),
    [tracks, colorOf],
  );
  const trail = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: tracks
        .map((tr) => {
          const pts = tr.pts.filter((p) => p.t <= realT).map((p) => [p.lng, p.lat]);
          const pose = poses.find((x) => x.who === tr.who);
          if (pose) pts.push([pose.lng, pose.lat]);
          return { type: 'Feature' as const, properties: { color: colorOf[tr.who] }, geometry: { type: 'LineString' as const, coordinates: pts } };
        })
        .filter((f) => f.geometry.coordinates.length >= 2),
    }),
    [tracks, realT, poses, colorOf],
  );
  const bounds = useMemo(() => {
    const all = tracks.flatMap((tr) => tr.pts);
    if (all.length < 2) return undefined;
    const b = bboxOf(all, 250);
    return { ne: [b.east, b.north] as [number, number], sw: [b.west, b.south] as [number, number], paddingTop: 50, paddingBottom: 40, paddingLeft: 40, paddingRight: 40 };
  }, [tracks]);

  // Emotes whose time just passed: a bubble above the sender for a moment.
  const bubbles = useMemo(() => {
    if (!playing) return [];
    return timeline.filter((e) => e.kind === 'emote' && e.who && clock.playAt(e.t) <= play && play - clock.playAt(e.t) < BUBBLE_MS * rate);
  }, [timeline, play, playing, clock, rate]);

  if (!bounds) return null;
  const done = play >= clock.durationMs;
  return (
    <View>
      <View style={{ height }} testID="mem-playback">
        <MapView style={{ flex: 1 }} styleURL="mapbox://styles/mapbox/standard" scaleBarEnabled={false} compassEnabled={false} onMapLoadingError={onMapboxLoadingError} attributionPosition={{ bottom: 6, left: 6 }} logoPosition={{ bottom: 6, left: 80 }}>
          <Camera defaultSettings={{ bounds }} />
          <ShapeSource id="mem-full" shape={full}>
            <LineLayer id="mem-full-line" slot="top" style={{ lineColor: ['get', 'color'], lineWidth: 3, lineOpacity: 0.25, lineCap: 'round', lineJoin: 'round' }} />
          </ShapeSource>
          <ShapeSource id="mem-trail" shape={trail}>
            <LineLayer id="mem-trail-casing" slot="top" style={{ lineColor: '#FFFFFF', lineWidth: 8, lineCap: 'round', lineJoin: 'round', lineOpacity: 0.85 }} />
            <LineLayer id="mem-trail-line" slot="top" style={{ lineColor: ['get', 'color'], lineWidth: 5, lineCap: 'round', lineJoin: 'round' }} />
          </ShapeSource>
          {poses.map((p) => {
            const who = people[p.who];
            if (!who) return null;
            const bubble = bubbles.filter((b) => b.who === p.who).slice(-1)[0];
            return (
              <MarkerView key={p.who} coordinate={[p.lng, p.lat]} allowOverlap anchor={{ x: 0.5, y: 0.75 }}>
                <View style={styles.marker} pointerEvents="none">
                  {bubble && (
                    <Animated.View key={`${bubble.t}`} entering={ZoomIn.springify().damping(12)} exiting={FadeOutUp.duration(250)} style={[styles.bubble, { backgroundColor: th.card, borderColor: colorOf[p.who] }]}>
                      <Text style={styles.bubbleText}>{emojiOf(bubble.ref ?? '')}</Text>
                    </Animated.View>
                  )}
                  <MapSprite avatar={who.avatar} car={who.car} driving={p.moving || !done} walking={false} heading={p.heading} bearing={0} size={54} />
                  <View style={[styles.tag, { backgroundColor: colorOf[p.who] }]}>
                    <Text style={[type.caption, font('bold'), { color: '#fff' }]} numberOfLines={1}>
                      {who.name}
                    </Text>
                  </View>
                </View>
              </MarkerView>
            );
          })}
        </MapView>
        <View style={[styles.clock, { backgroundColor: th.glass }]} pointerEvents="none">
          <Text style={[type.small, { color: th.text, fontVariant: ['tabular-nums'] }]}>{formatClock(realT)}</Text>
        </View>
      </View>
      <View style={styles.controls}>
        <Bouncy
          testID="mem-play"
          accessibilityRole="button"
          accessibilityLabel={playing ? t('trip.pause') : t('trip.play')}
          haptic="select"
          onPress={() => {
            if (!playing && done) setPlay(0);
            setPlaying(!playing);
          }}
          style={[styles.play, { backgroundColor: th.accent }]}
        >
          <Glyph kind={playing ? 'pause' : 'play'} color={th.onAccent} />
        </Bouncy>
        <View style={{ flex: 1 }}>
          <Scrubber testID="mem-scrubber" label={t('mem.playback')} value={clock.durationMs ? play / clock.durationMs : 0} onStart={() => setPlaying(false)} onChange={(f) => setPlay(f * clock.durationMs)} />
        </View>
        {RATES.map((r) => (
          <Chip key={r} testID={`mem-rate-${r}`} label={`${r}×`} active={rate === r} onPress={() => setRate(r)} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  marker: { alignItems: 'center' },
  tag: { marginTop: -6, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, maxWidth: 110 },
  bubble: { position: 'absolute', top: -38, minWidth: 40, height: 40, borderRadius: 20, borderWidth: 2, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  bubbleText: { fontSize: 22 },
  clock: { position: 'absolute', top: 10, right: 10, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 10 },
  play: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
