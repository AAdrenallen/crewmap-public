import { Component, useEffect, useState, type ReactNode } from 'react';
import { useActiveInterval } from '../useActiveInterval';
import { Image, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { DEFAULT_CAR, headingFrame, SPRITE_HEADINGS, type AvatarConfig, type CarConfig } from '@crewmap/shared/avatar';
import { AVATAR_FRAMES, AVATAR_HALF, avatarPortrait, avatarSheet, parkedSheet, RIDE_HALF, rideSheet } from '../../avatar3d/baker';
import { rideFallback } from '../../avatar3d/bakeGuard';
import { recordError } from '../../core/errorLog';
import { Icon } from '../kitIcons';
import { useTheme } from '../theme';

/** Sheet URIs by config, LRU-capped; the decoded bitmaps live in the native image cache, which evicts on its own. */
const SHEET_CACHE_MAX = 48;
const sheetCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
function cacheGet(key: string): string | undefined {
  const v = sheetCache.get(key);
  if (v !== undefined) {
    sheetCache.delete(key);
    sheetCache.set(key, v);
  }
  return v;
}
function cachePut(key: string, uri: string): void {
  sheetCache.delete(key);
  sheetCache.set(key, uri);
  while (sheetCache.size > SHEET_CACHE_MAX) sheetCache.delete(sheetCache.keys().next().value as string);
}

/** Keys whose bake failed this session: not retried on every mount (the flat badge shows instead). */
const failedKeys = new Set<string>();
/** Ride models whose bake failed this session: they ride the default model instead. */
const failedRides = new Set<string>();

function logBakeFailure(what: string, e: unknown): void {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  recordError('js', new Error(`sprite bake failed (${what}): ${msg}`));
  if (__DEV__) console.warn('sprite bake failed', what, e);
}

type SheetState = { uri: string | null; failed: boolean };

/** `key` null = not needed now: nothing is baked or decoded for it. */
function useSheet(key: string | null, make: () => Promise<string>, onFail?: (e: unknown) => void): SheetState {
  const [state, setState] = useState<SheetState>(() => ({ uri: key === null ? null : (cacheGet(key) ?? null), failed: key !== null && failedKeys.has(key) }));
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const hit = cacheGet(key);
    if (hit !== undefined) {
      setState({ uri: hit, failed: false });
      return;
    }
    if (failedKeys.has(key)) {
      setState({ uri: null, failed: true });
      return;
    }
    // One bake per config even when many markers mount with it at once.
    let p = inflight.get(key);
    if (!p) {
      let started: Promise<string>;
      try {
        started = make();
      } catch (e) {
        started = Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      p = started
        .catch((e: unknown) => {
          failedKeys.add(key);
          logBakeFailure(key.slice(0, 1), e);
          onFail?.(e);
          throw e;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    p.then(
      (u) => {
        cachePut(key, u);
        if (live) setState({ uri: u, failed: false });
      },
      () => {
        if (live) setState({ uri: null, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  return key === null ? { uri: null, failed: false } : state;
}

export function useAvatarSheet(cfg: AvatarConfig): string | null {
  const key = `a:${JSON.stringify(cfg)}`;
  return useSheet(key, () => avatarSheet(cfg)).uri;
}

/** The avatar on their vehicle; only baked once `enabled` (i.e. the friend is actually driving). A ride whose bake failed rides the default model. */
export function useRideSheet(avatar: AvatarConfig, car: CarConfig, enabled: boolean): string | null {
  const [, bump] = useState(0);
  const ride = rideFallback(car, failedRides);
  const key = enabled ? `r:${JSON.stringify([avatar, ride])}` : null;
  return useSheet(
    key,
    () => rideSheet(avatar, ride),
    () => {
      if (ride.model === DEFAULT_CAR.model) return;
      failedRides.add(ride.model);
      bump((n) => n + 1);
    },
  ).uri;
}

function usePortrait(cfg: AvatarConfig): SheetState {
  const key = `p:${JSON.stringify(cfg)}`;
  return useSheet(key, () => avatarPortrait(cfg));
}

/** Flat stand-in when a sprite cannot be baked (GL/driver failure): never a crash, never an empty hole. */
function SpriteBadge({ size }: { size: number }) {
  const th = useTheme();
  return (
    <View testID="sprite-fallback" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: th.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="person" size={Math.round(size * 0.55)} color={th.accent} />
    </View>
  );
}

/**
 * Render errors in a sprite or 3D stage (bake, GL, decode, animation) show a fallback (the flat badge by default)
 * instead of unmounting the screen.
 */
export class SpriteBoundary extends Component<{ size: number; children: ReactNode; fallback?: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError(): { error: boolean } {
    return { error: true };
  }
  componentDidCatch(e: unknown): void {
    logBakeFailure('render', e);
  }
  render(): ReactNode {
    return this.state.error ? (this.props.fallback ?? <SpriteBadge size={this.props.size} />) : this.props.children;
  }
}

/** Ride cells are framed wider than avatar cells (baker RIDE_HALF), so they are drawn larger to keep world scale. */
const RIDE_SCALE = RIDE_HALF / AVATAR_HALF;
/** Ms per sheet column while turning: a 180° turn sweeps 8 frames in ~0.3 s instead of snapping. */
const TURN_STEP_MS = 38;

/** One cell of a sprite sheet (cols = 16 headings). */
function Cell({ uri, col, row, rows, size }: { uri: string; col: number; row: number; rows: number; size: number }) {
  return (
    <View style={{ width: size, height: size, overflow: 'hidden' }}>
      <Image
        source={{ uri }}
        // `scale` keeps the full-resolution sheet (Android's `resize` would downsample the whole strip first).
        resizeMethod="scale"
        style={{ position: 'absolute', width: size * SPRITE_HEADINGS, height: size * rows, left: -col * size, top: -row * size }}
        fadeDuration={0}
      />
    </View>
  );
}

/** Steps the shown column one frame at a time along the shortest way round, so turns read as a smooth rotation. */
function useTurningColumn(target: number): number {
  const [col, setCol] = useState(target);
  useEffect(() => {
    if (col === target) return;
    const diff = (((target - col) % SPRITE_HEADINGS) + SPRITE_HEADINGS) % SPRITE_HEADINGS;
    const dir = diff <= SPRITE_HEADINGS / 2 ? 1 : -1;
    const id = setTimeout(() => setCol((c) => (c + dir + SPRITE_HEADINGS) % SPRITE_HEADINGS), TURN_STEP_MS);
    return () => clearTimeout(id);
  }, [col, target]);
  return col;
}

/**
 * A friend on the map: avatar sprite (walking frames when moving on foot) or riding their vehicle when driving, oriented to
 * heading relative to the map bearing. Bounces when a new position arrives (Snapchat-Map energy) and briefly bobs
 * while idle. The soft contact shadow and outline are baked into the sheet.
 */
export function MapSprite(props: Parameters<typeof MapSpriteInner>[0]) {
  return (
    <SpriteBoundary size={props.size ?? 64}>
      <MapSpriteInner {...props} />
    </SpriteBoundary>
  );
}

function MapSpriteInner({
  avatar,
  car,
  driving,
  walking,
  heading,
  bearing,
  size = 64,
  bumpKey,
}: {
  avatar: AvatarConfig;
  car: CarConfig;
  driving: boolean;
  walking: boolean;
  heading: number | null;
  bearing: number;
  size?: number;
  bumpKey?: number;
}) {
  const aUri = useAvatarSheet(avatar);
  const rUri = useRideSheet(avatar, car, driving);
  const [step, setStep] = useState(0);
  const scale = useSharedValue(1);
  const bob = useSharedValue(0);
  const idle = !walking && !driving;
  useActiveInterval(() => setStep((s) => (s + 1) % 4), 220, walking);
  useEffect(() => {
    scale.value = withSequence(withTiming(1.15, { duration: 90 }), withSpring(1, { damping: 6, stiffness: 220 }));
  }, [bumpKey, scale]);
  useEffect(() => {
    if (!idle) {
      cancelAnimation(bob);
      bob.value = withTiming(0, { duration: 150 });
      return;
    }
    // A few bobs after each update, then still: an endless UI-thread animation per marker costs battery all day.
    bob.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.sin) }), 6, true);
    return () => cancelAnimation(bob);
  }, [idle, bob, bumpKey]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: -bob.value * size * 0.025 }, { scaleY: 1 + bob.value * 0.012 }, { scale: scale.value }],
  }));
  const col = useTurningColumn(headingFrame(heading, bearing));
  const row = walking ? [1, 0, 2, 0][step]! : 0;
  return (
    <Animated.View style={style} accessibilityIgnoresInvertColors>
      {driving && rUri ? (
        <Cell uri={rUri} col={col} row={0} rows={1} size={size * RIDE_SCALE} />
      ) : aUri ? (
        <Cell uri={aUri} col={col} row={row} rows={AVATAR_FRAMES} size={size} />
      ) : (
        <View style={{ width: size, height: size }} />
      )}
    </Animated.View>
  );
}

/** The parked car (D67): the user's own vehicle without the rider, frozen at the heading it stopped with. */
export function ParkedSprite({ car, heading, bearing, size = 48 }: { car: CarConfig; heading: number | null; bearing: number; size?: number }) {
  return (
    <SpriteBoundary size={size} fallback={<View style={{ width: size, height: size }} />}>
      <ParkedSpriteInner car={car} heading={heading} bearing={bearing} size={size} />
    </SpriteBoundary>
  );
}

function ParkedSpriteInner({ car, heading, bearing, size }: { car: CarConfig; heading: number | null; bearing: number; size: number }) {
  const ride = rideFallback(car, failedRides);
  const { uri, failed } = useSheet(`k:${JSON.stringify(ride)}`, () => parkedSheet(ride));
  if (failed)
    return (
      <View style={{ width: size * 0.7, height: size * 0.7, borderRadius: size, backgroundColor: 'rgba(14,18,32,0.82)', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="car" size={Math.round(size * 0.4)} color="#FFFFFF" />
      </View>
    );
  return uri ? <Cell uri={uri} col={headingFrame(heading, bearing)} row={0} rows={1} size={size * RIDE_SCALE} /> : <View style={{ width: size, height: size }} />;
}

/** One frozen cell of a person's existing walk sheet (group scenes): no animation, no extra bake. */
export function PosedSprite({ avatar, frame, heading, size }: { avatar: AvatarConfig; frame: number; heading: number; size: number }) {
  return (
    <SpriteBoundary size={size}>
      <PosedSpriteInner avatar={avatar} frame={frame} heading={heading} size={size} />
    </SpriteBoundary>
  );
}

function PosedSpriteInner({ avatar, frame, heading, size }: { avatar: AvatarConfig; frame: number; heading: number; size: number }) {
  const uri = useAvatarSheet(avatar);
  return uri ? (
    <Cell uri={uri} col={heading % SPRITE_HEADINGS} row={Math.min(AVATAR_FRAMES - 1, frame)} rows={AVATAR_FRAMES} size={size} />
  ) : (
    <View style={{ width: size, height: size }} />
  );
}

/** Front-facing still for lists and sheets. */
export function AvatarStill({ avatar, size = 48 }: { avatar: AvatarConfig; size?: number }) {
  return (
    <SpriteBoundary size={size}>
      <AvatarStillInner avatar={avatar} size={size} />
    </SpriteBoundary>
  );
}

function AvatarStillInner({ avatar, size }: { avatar: AvatarConfig; size: number }) {
  // A dedicated 1-cell portrait (heading 180°, facing the camera): lists never decode the full walk sheet.
  const { uri, failed } = usePortrait(avatar);
  if (failed) return <SpriteBadge size={size} />;
  return uri ? <Image source={{ uri }} style={{ width: size, height: size }} fadeDuration={0} /> : <View style={{ width: size, height: size }} />;
}
