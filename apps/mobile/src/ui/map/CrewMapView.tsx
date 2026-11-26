import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { AppState, Dimensions, StyleSheet, Text, View } from 'react-native';
import { followPaddingFor, previewPaddingFor, useLayoutMode } from '../layout';
import Mapbox, {
  Camera,
  CameraGestureObserver,
  CircleLayer,
  CustomLocationProvider,
  HeatmapLayer,
  Images,
  LineLayer,
  MapView,
  MarkerView,
  RasterDemSource,
  ShapeSource,
  StyleImport,
  SymbolLayer,
  Terrain,
  VectorSource,
  type CircleLayerStyle,
  type HeatmapLayerStyle,
  type LineLayerStyle,
  type SymbolLayerStyle,
} from '@rnmapbox/maps';
import { policeDensity, type MergedHazard } from '@crewmap/hazards';
import { formatMinutes } from '@crewmap/shared/units';
import { minutesLeft } from '@crewmap/shared/companions';
import { useNow } from '../friend/useNow';
import { lightPreset } from '@crewmap/shared/sun';
import { bearingDeg, slicePolyline } from '@crewmap/shared/geo';
import type { NavRoute } from '@crewmap/shared/navigation';
import type { Place } from '@crewmap/shared/places';
import type { BBox } from '@crewmap/shared/geo';
import { MAPBOX_TOKEN } from '../../core/mapbox';
import { useApp, type AppState as StoreState } from '../../core/store';
import { useActiveInterval } from '../useActiveInterval';
import { palette } from '../theme';
import { MapSprite } from './Sprites';
import { HAZARD_ICON } from './hazardIcons';
import { PlacesLayer } from './PlacesLayer';
import { setMapBearing, useMapBearing } from './mapBearing';
import { CompanionRoutes } from './CompanionRoutes';
import { setProjector } from './projector';
import { useFriendPose, useSelfMotion, useSelfPose } from './motion';
import { getLastCenter } from '../../core/lastCenter';
import { finite } from '../../core/errorScrub';
import { onMapboxImageMissing, onMapboxLoadingError } from '../../core/errorLog';

Mapbox.setAccessToken(MAPBOX_TOKEN);
// No Mapbox telemetry: privacy, and no background event uploads (CPU, radio).
Mapbox.setTelemetryEnabled(false);

const CONGESTION_COLOR: Record<string, string> = {
  unknown: '#5B6CFF',
  low: '#5B6CFF',
  moderate: '#FFB224',
  heavy: '#E5484D',
  severe: '#8E1B1E',
};
const HAZARD_IMAGES = Object.fromEntries(Object.entries(HAZARD_ICON).map(([k, v]) => [`hz-${k}`, v]));
/** Hazards reported within this window get a halo. */
const HAZARD_FRESH_MS = 2 * 60_000;
/** Native camera-steady events: at most this often during continuous follow (viewport + sprite bearing refresh). */
const CAMERA_POLL_MS = 500;
/** Light preset is re-evaluated this often (dawn/dusk transitions are 30-min windows). */
const PRESET_EVERY_MS = 60_000;
/**
 * Terrain exaggeration. Terrain costs GPU on every frame (and lifts every 3D layer); 1.15 keeps relief readable
 * at driving pitch for clearly less overdraw than the former 1.4.
 */
const TERRAIN_STYLE = { exaggeration: 1.15 };

export interface CrewMapHandle {
  recenter(): void;
  flyTo(lat: number, lng: number, zoom?: number): void;
}

function routeFeatures(route: NavRoute) {
  // Split the route into congestion-coloured segments (merge runs of equal congestion).
  const feats: GeoJSON.Feature<GeoJSON.LineString, { color: string }>[] = [];
  let start = 0;
  for (let i = 1; i <= route.congestion.length; i++) {
    if (i === route.congestion.length || route.congestion[i] !== route.congestion[start]) {
      const coords = route.geometry.slice(start, i + 1).map((p) => [p.lng, p.lat]);
      if (coords.length >= 2)
        feats.push({
          type: 'Feature',
          properties: { color: CONGESTION_COLOR[route.congestion[start] ?? 'unknown']! },
          geometry: { type: 'LineString', coordinates: coords },
        });
      start = i;
    }
  }
  if (feats.length === 0 && route.geometry.length >= 2) {
    feats.push({
      type: 'Feature',
      properties: { color: CONGESTION_COLOR.low! },
      geometry: { type: 'LineString', coordinates: route.geometry.map((p) => [p.lng, p.lat]) },
    });
  }
  return { type: 'FeatureCollection' as const, features: feats };
}

// Static layer styles: module constants so the native side never re-applies them on a re-render.
const lineW = (z0: number, w0: number, z1: number, w1: number): LineLayerStyle['lineWidth'] => [
  'interpolate',
  ['linear'],
  ['zoom'],
  z0,
  w0,
  z1,
  w1,
];
const line = (s: LineLayerStyle) => s;
const circle = (s: CircleLayerStyle) => s;
const symbol = (s: SymbolLayerStyle) => s;
const heatmap = (s: HeatmapLayerStyle) => s;
const S = {
  tunnel: line({
    lineColor: '#8A93A8',
    lineOpacity: 0.35,
    lineWidth: lineW(12, 1, 17, 8),
    lineDasharray: [1, 1.2],
  }),
  bridgeShadow: line({
    lineColor: '#000000',
    lineOpacity: 0.28,
    lineBlur: 3,
    lineTranslate: [3, 5],
    lineWidth: lineW(12, 3, 17, 16),
  }),
  ramps: line({ lineColor: '#FFB224', lineOpacity: 0.75, lineWidth: lineW(13, 1.5, 17, 6) }),
  rampChevrons: symbol({
    symbolPlacement: 'line',
    symbolSpacing: 60,
    textField: '›',
    textSize: 18,
    textColor: '#B76E00',
    textHaloColor: '#FFFFFF',
    textHaloWidth: 1.5,
    textKeepUpright: false,
    textRotationAlignment: 'map',
  }),
  altCasing: line({
    lineColor: '#5B6275',
    lineWidth: 9,
    lineOpacity: 0.55,
    lineCap: 'round',
    lineJoin: 'round',
  }),
  altLine: line({ lineColor: '#AEB4C2', lineWidth: 6, lineCap: 'round', lineJoin: 'round' }),
  routeCasing: line({ lineColor: '#1F2A8A', lineWidth: 10, lineCap: 'round', lineJoin: 'round' }),
  routeCasingNav: line({ lineColor: '#1F2A8A', lineWidth: 13, lineCap: 'round', lineJoin: 'round' }),
  routeLine: line({ lineColor: ['get', 'color'], lineWidth: 7, lineCap: 'round', lineJoin: 'round' }),
  routeLineNav: line({ lineColor: ['get', 'color'], lineWidth: 9, lineCap: 'round', lineJoin: 'round' }),
  rampGlow: line({ lineColor: palette.sun, lineWidth: 18, lineOpacity: 0.45, lineBlur: 6 }),
  rampLine: line({ lineColor: '#FFFFFF', lineWidth: 5, lineDasharray: [2, 1.5] }),
  heat: heatmap({
    heatmapWeight: ['get', 'w'],
    heatmapRadius: 30,
    heatmapOpacity: 0.55,
    heatmapColor: [
      'interpolate',
      ['linear'],
      ['heatmap-density'],
      0,
      'rgba(91,108,255,0)',
      0.4,
      'rgba(91,108,255,0.5)',
      1,
      'rgba(229,72,77,0.85)',
    ],
  }),
  // Static halo for fresh reports (was a 700 ms JS-driven pulse that re-rendered the whole map).
  hazardHalo: circle({
    circleColor: palette.sun,
    circleRadius: 20,
    circleOpacity: 0.28,
    circleStrokeColor: palette.sun,
    circleStrokeWidth: 2,
    circleStrokeOpacity: 0.7,
    circlePitchAlignment: 'map',
  }),
};
/** Layer filter expression type (not exported by rnmapbox). */
type Filter = NonNullable<ComponentProps<typeof LineLayer>['filter']>;
const FRESH_FILTER: Filter = ['==', ['get', 'fresh'], true];
const TUNNEL_FILTER: Filter = ['==', ['get', 'structure'], 'tunnel'];
const BRIDGE_FILTER: Filter = ['==', ['get', 'structure'], 'bridge'];
const DECK_FILTER: Filter = [
  'all',
  ['==', ['get', 'structure'], 'bridge'],
  [
    'match',
    ['get', 'class'],
    [
      'motorway',
      'trunk',
      'primary',
      'secondary',
      'tertiary',
      'motorway_link',
      'trunk_link',
      'primary_link',
      'street',
      'street_limited',
    ],
    true,
    false,
  ],
];
const RAMP_FILTER: Filter = [
  'match',
  ['get', 'class'],
  ['motorway_link', 'trunk_link', 'primary_link'],
  true,
  false,
];
const CHEVRON_FILTER: Filter = ['match', ['get', 'class'], ['motorway_link', 'trunk_link'], true, false];
/** (i) button width + gap: the wordmark sits just left of it. */
const ATTRIB_W = 30;
const HITBOX = { width: 24, height: 24 };
const MARKER_ANCHOR = { x: 0.5, y: 0.85 };

/** Light preset from the sun at the current fix, re-evaluated once a minute (not per render / per fix). */
function useLightPreset(): 'day' | 'night' | 'dawn' | 'dusk' {
  const hasFix = useApp((s) => s.fix !== null);
  const compute = () => {
    const f = useApp.getState().fix;
    return f ? lightPreset(Date.now(), f.lat, f.lng) : 'day';
  };
  const [preset, setPreset] = useState(compute);
  useEffect(() => {
    setPreset(compute());
  }, [hasFix]);
  useActiveInterval(() => setPreset(compute()), PRESET_EVERY_MS);
  return preset;
}

/** Index of the ramp step being highlighted (-1 when none): changes a few times per route, not per fix. */
const rampStepSel = (s: StoreState): number => {
  const p = s.nav?.progress;
  if (!s.nav || !p?.upcomingRamp) return -1;
  return s.nav.route.steps.findIndex((st) => st.isRamp && st.endAlongM >= p.alongM);
};

// Always mounted (empty when there is no route): unmounting the source while its layers update raced into
// "Source 'route' is not in style" when navigation ended.
const EMPTY_ROUTE: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const RouteLayer = memo(function RouteLayer({ route, navigating }: { route: NavRoute | null; navigating: boolean }) {
  const shape = useMemo(() => (route ? routeFeatures(route) : EMPTY_ROUTE), [route]);
  return (
    <ShapeSource id="route" shape={shape}>
      <LineLayer id="route-casing" slot="middle" style={navigating ? S.routeCasingNav : S.routeCasing} />
      <LineLayer id="route-line" slot="middle" style={navigating ? S.routeLineNav : S.routeLine} />
    </ShapeSource>
  );
});

const RampLayer = memo(function RampLayer() {
  const route = useApp((s) => s.nav?.route ?? null);
  const idx = useApp(rampStepSel);
  const shape = useMemo(() => {
    const st = idx >= 0 ? route?.steps[idx] : undefined;
    if (!route || !st) return null;
    const line = slicePolyline(route.geometry, route.cum, st.startAlongM, st.endAlongM);
    // A LineString needs 2+ positions; a degenerate slice makes Mapbox reject the source.
    if (line.length < 2) return null;
    return {
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: line.map((p) => [p.lng, p.lat]) },
    };
  }, [route, idx]);
  if (!shape) return null;
  return (
    <ShapeSource id="ramp-hl" shape={shape}>
      <LineLayer id="ramp-hl-glow" slot="top" style={S.rampGlow} />
      <LineLayer id="ramp-hl-line" slot="top" style={S.rampLine} />
    </ShapeSource>
  );
});

const HazardLayers = memo(function HazardLayers({
  driving,
  onPress,
}: {
  driving: boolean;
  onPress: (h: MergedHazard) => void;
}) {
  const hazards = useApp((s) => s.hazards);
  // Minute tick so the fresh halo expires even when the hazard list does not change.
  const [minute, setMinute] = useState(0);
  useActiveInterval(() => setMinute((m) => m + 1), 60_000);
  const hazardShape = useMemo(() => {
    const now = Date.now();
    return {
      type: 'FeatureCollection' as const,
      features: hazards.map((h) => ({
        type: 'Feature' as const,
        id: h.id,
        properties: { id: h.id, icon: `hz-${h.type}`, fresh: now - h.latestReportAt < HAZARD_FRESH_MS },
        geometry: { type: 'Point' as const, coordinates: [h.lng, h.lat] },
      })),
    };
  }, [hazards, minute]);
  const densityShape = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: policeDensity(hazards).map((p) => ({
        type: 'Feature' as const,
        properties: { w: p.weight },
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      })),
    }),
    [hazards],
  );
  const iconStyle = useMemo(
    () =>
      symbol({
        iconImage: ['get', 'icon'],
        iconAnchor: 'bottom',
        iconSize: ['interpolate', ['linear'], ['zoom'], 10, 0.55, 15, driving ? 0.95 : 0.8, 18, 1.1],
        iconAllowOverlap: true,
        iconIgnorePlacement: true,
        iconPitchAlignment: 'viewport',
        iconOpacityTransition: { duration: 400, delay: 0 },
        symbolSortKey: ['case', ['get', 'fresh'], 1, 0],
      }),
    [driving],
  );
  const press = useCallback(
    (e: { features: GeoJSON.Feature[] }) => {
      const id = e.features[0]?.properties?.id as string | undefined;
      const h = useApp.getState().hazards.find((x) => x.id === id);
      if (h) onPress(h);
    },
    [onPress],
  );
  return (
    <>
      <ShapeSource id="police-density" shape={densityShape}>
        <HeatmapLayer id="police-heat" slot="middle" maxZoomLevel={14} style={S.heat} />
      </ShapeSource>
      <Images images={HAZARD_IMAGES} onImageMissing={onMapboxImageMissing} />
      <ShapeSource id="hazards" shape={hazardShape} onPress={press}>
        <CircleLayer id="hazard-pulse" slot="top" filter={FRESH_FILTER} style={S.hazardHalo} />
        <SymbolLayer id="hazard-icons" slot="top" style={iconStyle} />
      </ShapeSource>
    </>
  );
});

const FriendMarker = memo(function FriendMarker({
  f,
  bearing,
  onPress,
}: {
  f: StoreState['friends'][string];
  bearing: number;
  onPress: (id: string) => void;
}) {
  const p = f.presence!;
  // Tweened between presence updates (dead reckoning on their speed/heading, corrections blended).
  const pose = useFriendPose({ key: p.t, lat: p.lat, lng: p.lng, spd: p.spd, hdg: p.hdg });
  const coord = useMemo(() => [pose.lng, pose.lat], [pose.lng, pose.lat]);
  // Driving: a bigger touch target; the label carries the routed drive time (primary friend metric).
  const driving = useApp((s) => s.driving || s.nav?.active === true);
  const eta = f.etaS !== null && !f.paused ? formatMinutes(f.etaS) : null;
  // A one-time share (D47): compact countdown on the label, e.g. "Bob · ◷ 23m".
  const now = useNow();
  const once = f.once && f.once.until > now ? `◷ ${minutesLeft(f.once.until, now)}m` : null;
  const label = [f.profile.name, eta, once].filter(Boolean).join(' · ');
  return (
    <MarkerView coordinate={coord} allowOverlap allowOverlapWithPuck anchor={MARKER_ANCHOR}>
      <View
        accessible
        accessibilityLabel={f.profile.name}
        onTouchEnd={() => onPress(f.profile.deviceId)}
        style={[styles.marker, driving && styles.markerDrive]}
      >
        <MapSprite
          avatar={f.profile.avatar}
          car={f.profile.car}
          driving={p.act === 'automotive'}
          walking={p.act === 'walking' || p.act === 'running'}
          heading={pose.heading}
          bearing={bearing}
          bumpKey={p.act === 'automotive' ? undefined : p.t}
        />
        <View style={styles.nameChip}>
          <Text style={styles.name} numberOfLines={1}>
            {label}
          </Text>
        </View>
      </View>
    </MarkerView>
  );
});

const FriendMarkers = memo(function FriendMarkers({ onPress }: { onPress: (id: string) => void }) {
  const friends = useApp((s) => s.friends);
  const bearing = useMapBearing((s) => s.bearing);
  return (
    <>
      {Object.values(friends).map((f) =>
        f.presence && !f.paused ? (
          <FriendMarker key={f.profile.deviceId} f={f} bearing={bearing} onPress={onPress} />
        ) : null,
      )}
    </>
  );
});

/**
 * Own position for the native location component: the follow camera tracks this (not the platform provider), so
 * camera and sprite share one smoothed source, in replays too. Re-renders at the pose tick, nothing else does.
 */
const SelfLocation = memo(function SelfLocation() {
  const pose = useSelfPose((s) => s.pose);
  const camBearing = useSelfPose((s) => s.bearing);
  if (!pose || !finite(pose.lat) || !finite(pose.lng)) return null;
  return (
    <CustomLocationProvider coordinate={[pose.lng, pose.lat]} heading={finite(camBearing) ? camBearing : 0} />
  );
});

/** Own sprite, positioned from the same smoothed pose as the camera (≤ 10 Hz, this component only). */
const SelfMarker = memo(function SelfMarker() {
  const pose = useSelfPose((s) => s.pose);
  const camBearing = useSelfPose((s) => s.bearing);
  const fixT = useApp((s) => s.fix?.t ?? 0);
  const me = useApp((s) => s.me);
  const driving = useApp((s) => s.driving);
  const walking = useApp((s) => s.activity === 'walking');
  const navigating = useApp((s) => s.nav?.active === true);
  const bearing = useMapBearing((s) => s.bearing);
  if (!pose || !me) return null;
  // Heading-up follow: the native camera bearing is the provider bearing (course moving, compass stopped), so draw
  // the car relative to it instead
  // of the (polled, up to CAMERA_POLL_MS stale) camera bearing, which would show it sideways mid-turn.
  const headingUp = (driving || navigating) && camBearing !== null;
  const shownBearing = headingUp ? camBearing! : bearing;
  return (
    <MarkerView coordinate={[pose.lng, pose.lat]} allowOverlap allowOverlapWithPuck anchor={MARKER_ANCHOR}>
      <View style={styles.marker}>
        {/* No per-fix bounce while driving: at 1 Hz it reads as a pulse, not as motion. */}
        <MapSprite
          avatar={me.avatar}
          car={me.car}
          driving={driving}
          walking={walking}
          heading={pose.heading}
          bearing={shownBearing}
          size={72}
          bumpKey={driving ? undefined : fixT}
        />
      </View>
    </MarkerView>
  );
});

interface Props {
  onViewport?: (b: BBox | null) => void;
  onFriendPress?: (id: string) => void;
  onLongPress?: (lat: number, lng: number) => void;
  onHazardPress?: (h: MergedHazard) => void;
  onPlacePress?: (p: Place) => void;
  overlay?: ReactNode;
  /** Where the Mapbox wordmark + (i) attribution sit (top-right, below the top chrome). Mapbox requires both to stay
   *  visible on the map at their native size; they may only be moved (docs.mapbox.com/help/getting-started/attribution). */
  ornaments?: { top: number; right: number };
}

const CrewMapViewImpl = forwardRef<CrewMapHandle, Props>(function CrewMapView(props, ref) {
  const { overlay, ornaments } = props;
  const oTop = Math.round(ornaments?.top ?? 8);
  const oRight = Math.round(ornaments?.right ?? 8);
  const logoPos = useMemo(() => ({ top: oTop, right: oRight + ATTRIB_W }), [oTop, oRight]);
  const attribPos = useMemo(() => ({ top: oTop, right: oRight }), [oTop, oRight]);
  // Callbacks via a ref: parents pass inline lambdas, which must not re-render the map tree.
  const cb = useRef(props);
  cb.current = props;
  const cam = useRef<Camera>(null);
  const mapRef = useRef<MapView>(null);
  const hasFix = useApp((s) => s.fix !== null);
  const driving = useApp((s) => s.driving);
  const route = useApp((s) => s.nav?.route ?? null);
  const candidates = useApp((s) => s.nav?.candidates ?? null);
  const navigating = useApp((s) => s.nav?.active === true);
  const [follow, setFollow] = useState(true);
  // Follow mode runs Mapbox's own 1 Hz HIGH_ACCURACY location request; it must not outlive the foreground (battery).
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setAppActive(st === 'active'));
    return () => sub.remove();
  }, []);
  const followRef = useRef(follow);
  followRef.current = follow;

  useImperativeHandle(ref, () => ({
    recenter: () => setFollow(true),
    flyTo: (lat, lng, zoom = 15) => {
      setFollow(false);
      cam.current?.setCamera({
        centerCoordinate: [lng, lat],
        zoomLevel: zoom,
        animationDuration: 800,
        animationMode: 'flyTo',
      });
    },
  }));

  // Drive-along overlays (D31) project companions and briefly frame them without touching this tree's state.
  useEffect(() => {
    let back: ReturnType<typeof setTimeout> | null = null;
    setProjector({
      pointInView: async (lng, lat) => {
        const p = await mapRef.current?.getPointInView([lng, lat]);
        return [p?.[0] ?? NaN, p?.[1] ?? NaN];
      },
      showBoth: (a, b) => {
        setFollow(false);
        cam.current?.fitBounds(
          [Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)],
          [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat)],
          [140, 70, 160, 70],
          700,
        );
        if (back) clearTimeout(back);
        back = setTimeout(() => setFollow(true), 4000);
      },
    });
    return () => {
      if (back) clearTimeout(back);
      setProjector(null);
    };
  }, []);

  // Route preview: frame every candidate above the bottom sheet; starting navigation returns to follow mode.
  const preview = route !== null && !navigating;
  const previewLines = useMemo(
    () =>
      preview && route
        ? candidates && candidates.length > 0
          ? candidates.map((c) => c.route)
          : [route]
        : null,
    [preview, route, candidates],
  );
  const lay = useLayoutMode();
  const previewBounds = useMemo(() => {
    if (!previewLines) return null;
    let n = -90,
      s = 90,
      e = -180,
      w = 180;
    for (const r of previewLines) {
      for (const p of r.geometry) {
        n = Math.max(n, p.lat);
        s = Math.min(s, p.lat);
        e = Math.max(e, p.lng);
        w = Math.min(w, p.lng);
      }
    }
    // Portrait: the route sheet covers the bottom ~55%; landscape: the left panel. Keep every candidate visible.
    return { ne: [e, n], sw: [w, s], ...previewPaddingFor(lay) };
  }, [previewLines, lay.wide, lay.panelW, lay.height]);
  // Unselected candidates, drawn grey under the selected route; tapping one selects it.
  const altShape = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features:
        preview && route && candidates
          ? candidates
              .filter((c) => c.route.id !== route.id)
              .map((c) => ({
                type: 'Feature' as const,
                properties: { id: c.route.id },
                geometry: {
                  type: 'LineString' as const,
                  coordinates: c.route.geometry.map((p) => [p.lng, p.lat]),
                },
              }))
          : [],
    }),
    [preview, route, candidates],
  );
  // Preview frames the routes flat (pitch 0, follow off). When the preview closes without navigating, return to the
  // 3D follow view; otherwise the map stayed flat and zoomed out until the user tapped recenter.
  const hadPreview = useRef(false);
  useEffect(() => {
    if (previewBounds) {
      hadPreview.current = true;
      setFollow(false);
    } else if (hadPreview.current) {
      hadPreview.current = false;
      setFollow(true);
    }
  }, [previewBounds]);
  useEffect(() => {
    if (navigating) setFollow(true);
  }, [navigating]);

  const preset = useLightPreset();
  // Heading-up like Google Maps / Waze: the camera bearing follows the provider bearing (GPS course moving, compass
  // stopped; it arrives as "heading", so course mode would never rotate). Rotation stays native; JS feeds poses.
  const headingUp = navigating || driving;
  const trackMode = headingUp ? Mapbox.UserTrackingMode.FollowWithHeading : Mapbox.UserTrackingMode.Follow;
  useSelfMotion(headingUp);

  // While navigating, trees and facades go: they are the costliest Standard 3D layers per frame at driving pitch.
  // Buildings, landmarks and our raised bridge decks keep the 3D look.
  const styleConfig = useMemo(
    () => ({
      lightPreset: preset,
      show3dObjects: true,
      show3dBuildings: true,
      show3dFacades: !navigating,
      show3dLandmarks: true,
      show3dTrees: !navigating,
      showPointOfInterestLabels: !driving,
      showTransitLabels: false,
    }),
    [preset, navigating, driving],
  );
  const night = preset === 'night';
  const casingStyle = useMemo(
    () =>
      line({ lineColor: night ? '#C8D0E6' : '#FFFFFF', lineWidth: lineW(12, 2, 17, 12), lineOpacity: 0.85 }),
    [night],
  );
  const deckStyle = useMemo(
    () =>
      line({
        lineColor: night ? '#9AA5C4' : '#FFFFFF',
        lineWidth: lineW(14, 3, 18, 18),
        lineCap: 'butt',
        lineElevationReference: 'ground',
        lineZOffset: ['interpolate', ['linear'], ['line-progress'], 0, 0, 0.18, 7, 0.82, 7, 1, 0],
        lineBorderWidth: 1.5,
        lineBorderColor: 'rgba(40,48,70,0.55)',
      }),
    [night],
  );
  // Always an object: rnmapbox Android crashes (ClassCastException) when this prop goes from a map to null.
  const followPadding = useMemo(
    () => followPaddingFor(lay, headingUp, navigating),
    [lay.wide, lay.panelW, lay.height, headingUp, navigating],
  );
  const defaultSettings = useRef<{ centerCoordinate: number[]; zoomLevel: number; pitch: number } | null>(
    null,
  );
  if (!defaultSettings.current) {
    const f = useApp.getState().fix;
    // Fresh fix, else where the map was last centred on this phone, else a neutral city view.
    const c = f ?? getLastCenter();
    defaultSettings.current = {
      centerCoordinate: c ? [c.lng, c.lat] : [-73.5673, 45.5017],
      zoomLevel: c ? 15.5 : 9,
      pitch: 55,
    };
  }

  // No onCameraChanged: it serialises the full camera state to JS on every rendered frame while following.
  // A native observer reports at most every CAMERA_POLL_MS; viewport and sprite bearing are read then.
  const onSteady = useCallback((e: { nativeEvent: { lastGestureType?: string | null } }) => {
    if (e.nativeEvent.lastGestureType && followRef.current) setFollow(false);
    const m = mapRef.current;
    if (!m) return;
    const { width, height } = Dimensions.get('window');
    void Promise.all([
      m.getVisibleBounds(),
      m.getCoordinateFromView([width / 2, height * 0.75]),
      m.getCoordinateFromView([width / 2, height * 0.35]),
    ])
      .then(([b, lo, hi]) => {
        setMapBearing(bearingDeg({ lat: lo[1]!, lng: lo[0]! }, { lat: hi[1]!, lng: hi[0]! }));
        const [ne, sw] = b;
        cb.current.onViewport?.({ north: ne![1]!, east: ne![0]!, south: sw![1]!, west: sw![0]! });
      })
      .catch(() => undefined);
  }, []);
  const onLongPress = useCallback((f: GeoJSON.Feature) => {
    const c = (f.geometry as GeoJSON.Point).coordinates;
    cb.current.onLongPress?.(c[1]!, c[0]!);
  }, []);
  const onFriendPress = useCallback((id: string) => cb.current.onFriendPress?.(id), []);
  const onHazardPress = useCallback((h: MergedHazard) => cb.current.onHazardPress?.(h), []);
  const onPlacePress = useCallback((p: Place) => cb.current.onPlacePress?.(p), []);
  const onAltPress = useCallback((e: { features: GeoJSON.Feature[] }) => {
    const id = e.features[0]?.properties?.id as string | undefined;
    const s = useApp.getState();
    const pick = s.nav?.candidates.find((c) => c.route.id === id);
    if (s.nav && pick) s.set({ nav: { ...s.nav, route: pick.route } });
  }, []);

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        styleURL="mapbox://styles/mapbox/standard"
        compassEnabled={false}
        scaleBarEnabled={false}
        logoPosition={logoPos}
        attributionPosition={attribPos}
        onLongPress={onLongPress}
        onMapLoadingError={onMapboxLoadingError}
      >
        <CameraGestureObserver quietPeriodMs={200} maxIntervalMs={CAMERA_POLL_MS} onMapSteady={onSteady} />
        <StyleImport id="basemap" existing config={styleConfig} />
        <Camera
          ref={cam}
          followUserLocation={follow && hasFix && !previewBounds && appActive}
          bounds={previewBounds ?? undefined}
          {...(previewBounds ? { pitch: 0, heading: 0 } : {})}
          followUserMode={trackMode}
          followPadding={followPadding}
          followZoomLevel={navigating ? 17.5 : driving ? 16.2 : 16}
          followPitch={navigating ? 62 : driving ? 58 : 55}
          animationDuration={600}
          defaultSettings={defaultSettings.current}
        />
        <RasterDemSource id="dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={514}>
          <Terrain style={TERRAIN_STYLE} />
        </RasterDemSource>

        {/* F10: grade separation readability from Mapbox Streets v8 road attributes (structure, class *_link, layer). */}
        <VectorSource id="streets" url="mapbox://mapbox.mapbox-streets-v8">
          <LineLayer
            id="tunnel-fade"
            sourceLayerID="road"
            slot="middle"
            filter={TUNNEL_FILTER}
            style={S.tunnel}
          />
          <LineLayer
            id="bridge-shadow"
            sourceLayerID="road"
            slot="middle"
            minZoomLevel={12}
            filter={BRIDGE_FILTER}
            style={S.bridgeShadow}
          />
          <LineLayer
            id="bridge-casing"
            sourceLayerID="road"
            slot="middle"
            minZoomLevel={12}
            filter={BRIDGE_FILTER}
            style={casingStyle}
          />
          {/* Overpasses physically raised: deck ramps up from each abutment to ~7 m, so grade separation reads in 3D. */}
          <LineLayer
            id="bridge-deck"
            sourceLayerID="road"
            slot="top"
            minZoomLevel={14}
            filter={DECK_FILTER}
            style={deckStyle}
          />
          <LineLayer
            id="ramps"
            sourceLayerID="road"
            slot="middle"
            minZoomLevel={13}
            filter={RAMP_FILTER}
            style={S.ramps}
          />
          <SymbolLayer
            id="ramp-chevrons"
            sourceLayerID="road"
            slot="top"
            minZoomLevel={14}
            filter={CHEVRON_FILTER}
            style={S.rampChevrons}
          />
        </VectorSource>

        <PlacesLayer onPress={onPlacePress} />

        {altShape.features.length > 0 && (
          <ShapeSource id="route-alts" shape={altShape} hitbox={HITBOX} onPress={onAltPress}>
            <LineLayer id="route-alts-casing" slot="middle" style={S.altCasing} />
            <LineLayer id="route-alts-line" slot="middle" style={S.altLine} />
          </ShapeSource>
        )}
        <RouteLayer route={route} navigating={navigating} />
        {navigating && <RampLayer />}

        <HazardLayers driving={driving} onPress={onHazardPress} />

        <CompanionRoutes />
        <FriendMarkers onPress={onFriendPress} />
        <SelfLocation />
        <SelfMarker />
      </MapView>
      {overlay}
    </View>
  );
});

/** Memoised on `overlay` only: callback props are read through `cb` (refreshed on each render of the impl), so a
 * parent re-render with new inline lambdas does not re-render the map; the latest lambdas apply on the next one. */
export const CrewMapView = memo(
  CrewMapViewImpl,
  (a, b) => a.overlay === b.overlay && Math.round(a.ornaments?.top ?? 0) === Math.round(b.ornaments?.top ?? 0) && Math.round(a.ornaments?.right ?? 0) === Math.round(b.ornaments?.right ?? 0),
);

const styles = StyleSheet.create({
  marker: { alignItems: 'center' },
  markerDrive: { padding: 12 },
  nameChip: {
    marginTop: -6,
    backgroundColor: 'rgba(14,18,32,0.82)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    maxWidth: 140,
  },
  name: { color: '#fff', fontSize: 12, fontWeight: '800' },
});
