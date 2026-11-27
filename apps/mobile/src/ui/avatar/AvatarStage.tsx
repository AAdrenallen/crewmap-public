import { Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Defs, Ellipse, RadialGradient, Rect, Stop } from 'react-native-svg';
import { Canvas, useFrame, useThree } from '@react-three/fiber/native';
import * as THREE from 'three';
import { DEFAULT_CAR, type AvatarConfig, type CarConfig } from '@crewmap/shared/avatar';
import { BAKE_PHASE, type FinishClock } from '../../avatar3d/finishes';
import { buildAvatar, buildRide, pose, type AvatarRig } from '../../avatar3d/kit';
import { recordError } from '../../core/errorLog';
import { Icon } from '../kitIcons';
import { AvatarStill, SpriteBoundary } from '../map/Sprites';
import { radius as radii, useTheme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';
import { RIDE_ICON } from './avatarParts';

/**
 * Camera framing: the orbit target (world y), distance and default tilt. The avatar's whole-body view and the ride
 * view, plus a close-up per part tab so picking a category zooms onto that body area.
 */
interface Frame {
  y: number;
  dist: number;
  pitch: number;
}
const AVATAR_Y = -0.45;
const FULL: Frame = { y: 0, dist: 2.38, pitch: 0.39 };
const RIDE: Frame = { y: 0, dist: 3.58, pitch: 0.46 };
const FOCUS: Record<string, Frame> = {
  hair: { y: 0.5, dist: 1.25, pitch: 0.3 },
  hat: { y: 0.56, dist: 1.8, pitch: 0.3 },
  face: { y: 0.42, dist: 1.0, pitch: 0.15 },
  glasses: { y: 0.42, dist: 1.0, pitch: 0.15 },
  top: { y: 0.1, dist: 1.55, pitch: 0.25 },
  accessory: { y: 0.15, dist: 1.6, pitch: 0.25 },
  bottom: { y: -0.2, dist: 1.5, pitch: 0.25 },
  shoes: { y: -0.38, dist: 1.2, pitch: 0.45 },
};
/** Drag sensitivity (rad per dp), tilt and zoom limits, and how long a touch pauses the ride's auto-spin. */
const YAW_PER_DP = 0.012;
const PITCH_PER_DP = 0.006;
const PITCH_MIN = -0.15;
const PITCH_MAX = 1.0;
const ZOOM_MIN = 0.55;
const ZOOM_MAX = 1.8;
const SPIN_PAUSE_MS = 3000;

/** Orbit state written by gestures (JS, only while touching) and read by the frame loop. */
interface Orbit {
  yaw: number;
  /** Tilt added to the frame's default. */
  tilt: number;
  zoom: number;
  touchedAt: number;
  /** Bumped by double-tap: the frame loop eases back to the default view. */
  reset: boolean;
}
const newOrbit = (): Orbit => ({ yaw: STILL_ANGLE, tilt: 0, zoom: 1, touchedAt: 0, reset: false });
/** Rapid taps (swatches, chips) settle before the model is rebuilt. */
const BUILD_SETTLE_MS = 150;
/** No model by then (GL context never came up, driver hang): show the flat fallback. */
const FALLBACK_AFTER_MS = 8000;
/** Spin speed (rad/s); with reduce motion the model stands still at a 3/4 angle. */
const SPIN = 0.6;
const STILL_ANGLE = -0.5;

type StageState = 'loading' | 'ready' | 'failed';

/** `value` after it has stopped changing for `ms` (compared by content, so new-but-equal objects do not restart it). */
function useSettled<T>(value: T, ms: number): T {
  const key = JSON.stringify(value);
  const [settled, setSettled] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    const id = setTimeout(() => setSettled(latest.current), ms);
    return () => clearTimeout(id);
  }, [key, ms]);
  return settled;
}

function disposeMaterials(root: THREE.Object3D): void {
  // Geometry and the toon ramp are shared with the kit cache; only the per-instance materials are freed.
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      try {
        m.dispose();
      } catch {
        // Already gone with the context.
      }
    }
  });
}

function Model({ avatar, car, ride, still, orbit, onState }: { avatar: AvatarConfig; car: CarConfig; ride: boolean; still: boolean; orbit: MutableRefObject<Orbit>; onState: (s: StageState) => void }) {
  const [obj, setObj] = useState<THREE.Object3D | null>(null);
  const group = useRef<THREE.Group>(null);
  const rig = useRef<AvatarRig | null>(null);
  const shown = useRef(false);
  const pop = useRef(1);
  const angle = useRef(STILL_ANGLE);
  // Animated finishes: one uniform shared by every finish material of this model, advanced in the frame loop below.
  const [clock] = useState<FinishClock>(() => ({ value: BAKE_PHASE }));
  const report = useRef(onState);
  report.current = onState;

  useEffect(() => {
    let live = true;
    const build = ride
      ? buildRide(avatar, car, clock)
          .catch((e: unknown) => {
            // A ride that fails to build previews the default model instead of an empty stage.
            recordError('js', new Error(`ride preview failed (${car.model}): ${e instanceof Error ? e.message : String(e)}`));
            return buildRide(avatar, { ...car, model: DEFAULT_CAR.model }, clock);
          })
          .then((root) => ({ root, rig: null }))
      : buildAvatar(avatar, clock).then((r) => ({ root: r.root, rig: r }));
    build
      .then((m) => {
        if (!live) {
          disposeMaterials(m.root);
          return;
        }
        rig.current = m.rig;
        pop.current = still ? 1 : 0.9;
        shown.current = true;
        setObj(m.root);
        report.current('ready');
      })
      .catch((e: unknown) => {
        recordError('js', e);
        // A failed rebuild keeps the last model on stage; only an empty stage falls back.
        if (live && !shown.current) report.current('failed');
      });
    return () => {
      live = false;
    };
    // `still` only shapes the entrance; it must not rebuild the model.
  }, [avatar, car, ride]);

  useEffect(
    () => () => {
      if (obj) disposeMaterials(obj);
    },
    [obj],
  );

  useFrame((state, dt) => {
    const g = group.current;
    if (!g) return;
    const o = orbit.current;
    // Rides keep a gentle spin unless recently touched; the avatar only turns when dragged.
    if (ride && !still && Date.now() - o.touchedAt > SPIN_PAUSE_MS) o.yaw += dt * SPIN;
    if (o.reset) o.yaw += (STILL_ANGLE - o.yaw) * Math.min(1, dt * 8);
    angle.current += (o.yaw - angle.current) * (still ? 1 : Math.min(1, dt * 14));
    g.rotation.y = angle.current;
    clock.value = still ? BAKE_PHASE : state.clock.elapsedTime;
    pop.current += (1 - pop.current) * Math.min(1, dt * 9);
    g.scale.setScalar(pop.current);
    if (rig.current) pose(rig.current, still ? 0 : Math.sin(state.clock.elapsedTime * 4) * 0.6);
  });

  return <group ref={group}>{obj && <primitive object={obj} />}</group>;
}

/** Eases the camera onto the current frame (mode + focused part) plus the user's tilt and zoom. */
function Framing({ ride, focus, still, orbit, children }: { ride: boolean; focus?: string; still: boolean; orbit: MutableRefObject<Orbit>; children: ReactNode }) {
  const camera = useThree((s) => s.camera);
  const group = useRef<THREE.Group>(null);
  const target = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3());
  // Initial offset only: afterwards the frame loop eases y (a changing `position` prop would snap it).
  const [start] = useState<[number, number, number]>(() => [0, ride ? 0 : AVATAR_Y, 0]);
  useFrame((_, dt) => {
    const f = ride ? RIDE : ((focus ? FOCUS[focus] : undefined) ?? FULL);
    const o = orbit.current;
    const k = still ? 1 : Math.min(1, dt * 5);
    if (o.reset) {
      o.tilt += (0 - o.tilt) * k;
      o.zoom += (1 - o.zoom) * k;
      if (Math.abs(o.tilt) < 0.005 && Math.abs(o.zoom - 1) < 0.005 && Math.abs(o.yaw - STILL_ANGLE) < 0.01) o.reset = false;
    }
    const pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, f.pitch + o.tilt));
    const d = f.dist * o.zoom;
    target.current.set(0, f.y + Math.sin(pitch) * d, Math.cos(pitch) * d);
    camera.position.lerp(target.current, k);
    look.current.y += (f.y - look.current.y) * k;
    camera.lookAt(look.current);
    if (group.current) group.current.position.y += ((ride ? 0 : AVATAR_Y) - group.current.position.y) * k;
  });
  return (
    <group ref={group} position={start}>
      {children}
    </group>
  );
}

/** Soft pulsing silhouette while the first model loads. */
function Shimmer({ size, still }: { size: number; still: boolean }) {
  const th = useTheme();
  const o = useSharedValue(0.5);
  useEffect(() => {
    if (still) return;
    o.value = withRepeat(withTiming(0.9, { duration: 750, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(o);
  }, [o, still]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  const c = th.dark ? 'rgba(255,255,255,0.14)' : 'rgba(53,64,214,0.12)';
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center, style]} testID="avatar-stage-loading">
      <View style={{ width: size * 0.26, height: size * 0.26, borderRadius: size, backgroundColor: c }} />
      <View style={{ width: size * 0.42, height: size * 0.36, borderTopLeftRadius: size, borderTopRightRadius: size, borderRadius: size * 0.08, backgroundColor: c, marginTop: size * 0.03 }} />
    </Animated.View>
  );
}

/** Flat stand-in when the live stage cannot run: the baked portrait (or its badge), plus the ride's glyph. */
function StageFallback({ avatar, car, ride, size }: { avatar: AvatarConfig; car: CarConfig; ride: boolean; size: number }) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.center]} testID="avatar-stage-fallback">
      <AvatarStill avatar={avatar} size={Math.round(size * 0.5)} />
      {ride && (
        <View style={[styles.rideTile, { backgroundColor: car.color }]}>
          <Icon name={RIDE_ICON[car.model] ?? 'car'} size={Math.round(size * 0.12)} color="#FFFFFF" strokeWidth={2.2} />
        </View>
      )}
    </View>
  );
}

/**
 * Live 3D preview of the avatar (walking in place) or the avatar riding their vehicle, built from the GLB kit (no
 * sprite bake per change). Shared by the editor and onboarding; keep one mounted across modes so the GL context is
 * reused. GL or model failures show the flat fallback, never a blank stage or a crash.
 */
export function AvatarStage({
  avatar,
  car,
  ride = false,
  focus,
  width,
  height,
  insetTop = 0,
  rounded = false,
  testID,
  children,
}: {
  avatar: AvatarConfig;
  car: CarConfig;
  ride?: boolean;
  /** Part tab the camera closes in on (hair, shoes, ...); ignored for rides. */
  focus?: string;
  width: number;
  height: number;
  /** Space kept clear above the 3D view (status bar when the stage is full-bleed). */
  insetTop?: number;
  rounded?: boolean;
  testID?: string;
  /** Overlay controls (back, shuffle, ...). */
  children?: ReactNode;
}) {
  const th = useTheme();
  const still = useReduceMotion();
  const a = useSettled(avatar, BUILD_SETTLE_MS);
  const c = useSettled(car, BUILD_SETTLE_MS);
  const [state, setState] = useState<StageState>('loading');
  const [camera] = useState(() => {
    const f = ride ? RIDE : FULL;
    return { position: [0, f.y + Math.sin(f.pitch) * f.dist, Math.cos(f.pitch) * f.dist] as [number, number, number], fov: 35 };
  });
  const orbit = useRef<Orbit>(newOrbit());
  // Drag turns (and slightly tilts), pinch zooms, double-tap resets. JS callbacks only run while touching; the
  // frame loop reads the orbit ref.
  const gesture = useMemo(() => {
    let yaw0 = 0;
    let tilt0 = 0;
    let zoom0 = 1;
    const touch = () => {
      orbit.current.touchedAt = Date.now();
      orbit.current.reset = false;
    };
    const pan = Gesture.Pan()
      .runOnJS(true)
      .maxPointers(1)
      .minDistance(2)
      .onStart(() => {
        touch();
        yaw0 = orbit.current.yaw;
        tilt0 = orbit.current.tilt;
      })
      .onUpdate((e) => {
        touch();
        orbit.current.yaw = yaw0 + e.translationX * YAW_PER_DP;
        orbit.current.tilt = Math.min(0.6, Math.max(-0.5, tilt0 + e.translationY * PITCH_PER_DP));
      });
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart(() => {
        touch();
        zoom0 = orbit.current.zoom;
      })
      .onUpdate((e) => {
        touch();
        orbit.current.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom0 / Math.max(0.01, e.scale)));
      });
    const reset = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .onEnd(() => {
        orbit.current.reset = true;
        orbit.current.touchedAt = 0;
      });
    return Gesture.Simultaneous(pan, pinch, reset);
  }, []);
  // A new focus or mode starts from that view's default tilt and zoom (the turn is kept).
  useEffect(() => {
    orbit.current.tilt = 0;
    orbit.current.zoom = 1;
  }, [focus, ride]);
  useEffect(() => {
    if (state !== 'loading') return;
    const id = setTimeout(() => setState((s) => (s === 'loading' ? 'failed' : s)), FALLBACK_AFTER_MS);
    return () => clearTimeout(id);
  }, [state]);
  const size = Math.min(width, height - insetTop);
  // Settled configs: the fallback portrait bakes per config, so rapid taps must not queue a bake each.
  const fallback = <StageFallback avatar={a} car={c} ride={ride} size={size} />;

  return (
    <View testID={testID} style={{ width, height, overflow: 'hidden', borderRadius: rounded ? radii.xl : 0 }}>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="stage" cx="50%" cy="45%" r="70%">
            <Stop offset="0" stopColor={th.dark ? '#2F3A66' : '#EEF1FF'} />
            <Stop offset="1" stopColor={th.dark ? '#121729' : '#C9D1FF'} />
          </RadialGradient>
        </Defs>
        <Rect width={width} height={height} fill="url(#stage)" />
        <Ellipse cx={width / 2} cy={height * 0.86} rx={Math.min(width, height) * 0.28} ry={14} fill="#000000" opacity={0.12} />
      </Svg>
      {state === 'failed' ? (
        fallback
      ) : (
        <SpriteBoundary size={size} fallback={fallback}>
          <View style={{ flex: 1, marginTop: insetTop }}>
          <Canvas camera={camera} style={{ flex: 1 }} pointerEvents="none">
            <hemisphereLight args={['#ffffff', '#8899bb', 2.2]} />
            <directionalLight position={[2, 4, 3]} intensity={2.4} />
            <Suspense fallback={null}>
              <Framing ride={ride} focus={focus} still={still} orbit={orbit}>
                <Model avatar={a} car={c} ride={ride} still={still} orbit={orbit} onState={(s) => setState((cur) => (cur === 'ready' ? cur : s))} />
              </Framing>
            </Suspense>
          </Canvas>
          {/* Touch layer above the GL view: the canvas can never steal the drag, so swiping turns the model in every tab. */}
          <GestureDetector gesture={gesture}>
            <View collapsable={false} style={StyleSheet.absoluteFill} testID={testID ? `${testID}-orbit` : undefined} />
          </GestureDetector>
          </View>
        </SpriteBoundary>
      )}
      {state === 'loading' && <Shimmer size={size} still={still} />}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  rideTile: { marginTop: 10, borderRadius: radii.m, paddingHorizontal: 14, paddingVertical: 8 },
});
