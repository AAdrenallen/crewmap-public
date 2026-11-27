import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CONVOY, DRIVE_ALONG, edgePlacement, gapLabel, groupRows, liveTargets, relationLabel, safeRect, spreadBlips, type Edge } from '@crewmap/shared/companions';
import { bearingDeg, normalizeDeg } from '@crewmap/shared/geo';
import { lang, t } from '@crewmap/shared/i18n';
import { formatClock, formatDistance } from '@crewmap/shared/units';
import { engine } from '../../core/engine';
import { gapText, useCompanionLive, useDriveAlong } from '../../core/companions';
import { useFriendContext } from './DriveHud';
import { noticePolicy } from './driveUx';
import { useApp } from '../../core/store';
import { Bouncy, Icon, IconButton } from '../kit';
import { useLayoutMode } from '../layout';
import { useMapBearing } from '../map/mapBearing';
import { ownerColor } from '../map/PlacesLayer';
import { projector } from '../map/projector';
import { elevation, font, type, useTheme } from '../theme';

const STRIP_W = 132;
const ROW_H = 48;
const MAX_ROWS = 4;

interface Row {
  id: string;
  name: string;
  label: string;
  offRoute: boolean;
  stale: boolean;
  /** Convoy (D65): place in the line (1 = front) and whether this member leads. */
  order: number | null;
  leader: boolean;
}

/** Convoy row label: signed gap to me along the leader's route ("2 lights behind", "3 min ahead", "800 m behind"). */
function convoyLabel(r: { m: number; s: number; lights: number | null } | undefined): string {
  if (!r) return '';
  const l = gapLabel(r.m >= 0 ? 'ahead' : 'behind', Math.abs(r.m), Math.abs(r.s), r.lights);
  const dir = r.m >= 0 ? 'da.ahead' : 'da.behind';
  // Under the smallest callout bucket the strip still shows the metres (only a true "together" says "With you").
  if (!l) return Math.abs(r.m) < CONVOY.togetherM ? t('da.here') : t(dir, { dist: formatDistance(Math.abs(r.m), lang()) });
  return t(dir, { dist: gapText(l, lang()) });
}

interface Blip {
  id: string;
  initial: string;
  x: number;
  y: number;
  edge: Edge;
  angleDeg: number;
  dist: string;
}

function labelText(l: ReturnType<typeof relationLabel>): string {
  if (l.kind === 'here') return t('da.here');
  return t(`da.${l.kind}`, { dist: formatDistance(l.m, lang()) });
}

/**
 * Convoy regroup alert (D65) for the banner: shown for `CONVOY.bannerMs`, held back right before a turn (same rule as
 * other driving notices), never tappable.
 */
function useConvoyAlert(): { text: string } | null {
  const a = useDriveAlong((s) => s.convoyAlert);
  const ctx = useFriendContext();
  const nextM = useApp((s) => s.nav?.progress?.next?.distanceM ?? null);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!a) return;
    const left = a.at + CONVOY.bannerMs - Date.now();
    if (left <= 0) return;
    const id = setTimeout(() => bump((n) => n + 1), left);
    return () => clearTimeout(id);
  }, [a]);
  if (!a || Date.now() - a.at > CONVOY.bannerMs) return null;
  const p = noticePolicy('groupDrive', ctx, nextM);
  return p === 'defer' || p === 'drop' ? null : { text: a.text };
}

/**
 * Drive-along HUD (D31): a compact companion strip docked to a free edge (left under the banner in portrait, right in
 * landscape, never over the speed badge, report button or footer), plus edge blips for companions off the visible
 * map. Updates at ≤ 4 Hz from its own interval reading `useCompanionLive` imperatively; the map tree never re-renders.
 * `top` = bottom of the banner / search block.
 */
export const CompanionOverlay = memo(function CompanionOverlay({ top }: { top: number }) {
  const router = useRouter();
  const th = useTheme();
  const lay = useLayoutMode();
  const insets = useSafeAreaInsets();
  const active = useDriveAlong((s) => (s.session ? liveTargets(s.session, engine.me.deviceId).join(',') : null));
  const regroup = useDriveAlong((s) => s.regroup);
  const alert = useConvoyAlert();
  const [rows, setRows] = useState<Row[]>([]);
  const [blips, setBlips] = useState<Blip[]>([]);
  const sig = useRef('');

  const stripLeft = !lay.wide;
  const stripTop = lay.wide ? insets.top + 72 : top + 8;
  const stripX = stripLeft ? lay.gutterL : undefined;

  useEffect(() => {
    if (!active) {
      setRows([]);
      setBlips([]);
      sig.current = '';
      return;
    }
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        const now = Date.now();
        const live = useCompanionLive.getState().live;
        const session = useDriveAlong.getState().session;
        const members = session?.members ?? {};
        const fix = useApp.getState().fix;
        const convoy = useCompanionLive.getState().convoy;
        // Convoy: rows in line order (front first); members off the convoy route go last.
        const orderOf = (id: string) => convoy?.rows.find((r) => r.id === id)?.order ?? null;
        const ids = active
          .split(',')
          .sort((a, b) => (convoy ? (orderOf(a) ?? 99) - (orderOf(b) ?? 99) : 0))
          .slice(0, MAX_ROWS);
        // Group drive: each companion's ETA (their own nav ETA, else a straight-line guess) or "arrived".
        const gl = session?.dest
          ? groupRows(session, engine.me.deviceId, null, Object.fromEntries(Object.entries(live).map(([k, c]) => [k, { lat: c.lat, lng: c.lng, eta: c.eta }])), now)
          : [];
        const nextRows: Row[] = ids.map((id) => {
          const c = live[id];
          const g = gl.find((x) => x.id === id);
          const arrived = g?.status === 'arrived';
          const order = convoy ? orderOf(id) : null;
          const label = arrived
            ? t('gd.arrived')
            : convoy && convoy.rel[id]
              ? convoyLabel(convoy.rel[id])
              : g
                ? g.etaAt
                  ? formatClock(g.etaAt)
                  : ''
                : c?.rel
                  ? labelText(relationLabel(c.rel))
                  : '';
          return {
            id,
            name: members[id]?.name ?? '',
            label,
            offRoute: convoy ? !arrived && order === null && !!c : !g && c?.rel?.onMyRoute === false,
            stale: !arrived && (!c || now - c.receivedAt > DRIVE_ALONG.staleMs),
            order,
            leader: convoy?.leader === id,
          };
        });
        const reserved = stripLeft
          ? { top: top + 4, bottom: insets.bottom + 110, left: lay.gutterL + STRIP_W + 4, right: lay.gutterR }
          : { top: insets.top + 8, bottom: insets.bottom + 110, left: lay.panelW + lay.gutterL, right: lay.gutterR + STRIP_W + 4 };
        const safe = safeRect(lay.width, lay.height, reserved);
        const p = projector();
        const camBearing = useMapBearing.getState().bearing;
        const raw: Blip[] = [];
        for (const id of ids) {
          const c = live[id];
          if (!c || !fix) continue;
          const pt = p ? await p.pointInView(c.lng, c.lat).catch(() => null) : null;
          const rel = normalizeDeg(bearingDeg(fix, c) - camBearing);
          const e = edgePlacement(pt ? { x: pt[0], y: pt[1] } : null, rel, safe);
          if (e.onScreen) continue;
          raw.push({ id, initial: (members[id]?.name ?? '?').slice(0, 1).toUpperCase(), x: e.x, y: e.y, edge: e.edge, angleDeg: e.angleDeg, dist: formatDistance(c.rel?.distM ?? 0, lang()) });
        }
        const nextBlips = spreadBlips(raw).map((b) => ({ ...b, x: Math.round(b.x), y: Math.round(b.y), angleDeg: Math.round(b.angleDeg / 5) * 5 }));
        const s = JSON.stringify([nextRows, nextBlips]);
        if (s !== sig.current) {
          sig.current = s;
          setRows(nextRows);
          setBlips(nextBlips);
        }
      } finally {
        busy = false;
      }
    };
    void run();
    const timer = setInterval(() => void run(), DRIVE_ALONG.blipEveryMs);
    return () => clearInterval(timer);
  }, [active, top, stripLeft, lay.width, lay.height, lay.gutterL, lay.gutterR, lay.panelW, insets.top, insets.bottom]);

  const show = (id: string) => {
    const c = useCompanionLive.getState().live[id];
    const fix = useApp.getState().fix;
    if (c && fix) projector()?.showBoth(fix, c);
  };

  return (
    <>
      <View pointerEvents="box-none" style={[styles.strip, { top: stripTop }, stripLeft ? { left: stripX } : { right: lay.gutterR }]}>
        <IconButton testID="drive-along-hud" icon="users" label={t('da.title')} size={44} active={!!active} onPress={() => router.push('/drive-along')} />
        {rows.slice(0, MAX_ROWS - (alert ? 1 : 0) - (regroup ? 1 : 0)).map((r) => (
          <Bouncy
            key={r.id}
            testID={`companion-${r.name}`}
            accessibilityLabel={t('da.show', { name: r.name })}
            onPress={() => show(r.id)}
            style={[styles.row, { backgroundColor: th.glass, borderColor: th.separator, opacity: r.stale ? 0.6 : 1 }, elevation.low]}
          >
            <View style={[styles.dot, { backgroundColor: ownerColor(r.id) }]}>
              <Text style={[type.small, font('bold'), { color: '#FFFFFF' }]}>{r.name.slice(0, 1).toUpperCase()}</Text>
              {r.order !== null && (
                <View style={[styles.order, { backgroundColor: r.leader ? th.accent : th.card, borderColor: th.separator }]} accessibilityLabel={r.leader ? `${t('cv.leader')} ${r.order}` : String(r.order)}>
                  <Text style={[styles.orderText, font('bold'), { color: r.leader ? th.onAccent : th.text }]}>{r.order}</Text>
                </View>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[type.caption, font('bold'), { color: th.text }]} numberOfLines={1}>
                {r.name}
              </Text>
              <Text style={[type.caption, { color: r.offRoute ? th.danger : th.textSoft }]} numberOfLines={1}>
                {r.stale ? t('da.stale') : r.offRoute ? t('da.offRoute') : r.label}
              </Text>
            </View>
          </Bouncy>
        ))}
        {!!alert && !!active && (
          <View testID="convoy-regroup-alert" pointerEvents="none" accessibilityLiveRegion="polite" style={[styles.row, styles.alert, { backgroundColor: th.glass, borderColor: th.danger }, elevation.low]}>
            <Icon name="warning" size={18} color={th.danger} />
            <Text style={[type.caption, font('bold'), { color: th.text, flex: 1 }]} numberOfLines={2}>
              {alert.text}
            </Text>
          </View>
        )}
        {!!regroup && !!active && (
          <View style={[styles.row, { backgroundColor: th.glass, borderColor: th.separator }]}>
            <Icon name="pin" size={18} color={th.accent} />
            <Text style={[type.caption, { color: th.text, flex: 1 }]} numberOfLines={2}>
              {t('da.regroup', { place: regroup.name })}
            </Text>
          </View>
        )}
      </View>
      {blips.map((b) => (
        <Bouncy key={b.id} testID={`blip-${b.id}`} accessibilityLabel={t('da.show', { name: b.initial })} onPress={() => show(b.id)} style={[styles.blip, { left: b.x - 22, top: b.y - 22 }]}>
          <View style={[styles.arrow, { transform: [{ rotate: `${b.angleDeg}deg` }] }]}>
            <View style={[styles.tip, { borderBottomColor: ownerColor(b.id) }]} />
          </View>
          <View style={[styles.blipDot, { backgroundColor: ownerColor(b.id) }, elevation.low]}>
            <Text style={[type.small, font('bold'), { color: '#FFFFFF' }]}>{b.initial}</Text>
          </View>
          <Text style={[styles.blipDist, type.caption, font('bold'), { color: th.text, backgroundColor: th.glass }]} numberOfLines={1}>
            {b.dist}
          </Text>
        </Bouncy>
      ))}
    </>
  );
});

const styles = StyleSheet.create({
  strip: { position: 'absolute', width: STRIP_W, gap: 6 },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFFFFF' },
  order: { position: 'absolute', right: -6, top: -6, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  orderText: { fontSize: 11, lineHeight: 14 },
  alert: { height: undefined, minHeight: ROW_H, paddingVertical: 6, borderWidth: 1.5 },
  blip: { position: 'absolute', width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  arrow: { position: 'absolute', width: 44, height: 44, alignItems: 'center' },
  tip: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 8, borderLeftColor: 'transparent', borderRightColor: 'transparent', marginTop: -6 },
  blipDot: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFFFFF' },
  blipDist: { position: 'absolute', top: 40, paddingHorizontal: 4, borderRadius: 6, overflow: 'hidden' },
});
