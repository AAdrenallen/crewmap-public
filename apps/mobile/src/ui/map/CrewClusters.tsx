import { memo, useEffect, useMemo } from 'react';
import { AppState, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { MarkerView } from '@rnmapbox/maps';
import { create } from 'zustand';
import { CLUSTER, centroid } from '@crewmap/shared/crewCluster';
import { pickGroupPose } from '@crewmap/shared/groupPoses';
import { t } from '@crewmap/shared/i18n';
import { useApp } from '../../core/store';
import { LiveRow } from '../home/FriendCard';
import { Icon } from '../kitIcons';
import { font, radius, type, useTheme } from '../theme';
import { AvatarStill, PosedSprite } from './Sprites';

export interface CrewCluster {
  ids: string[];
  /** Everyone within CLUSTER.sameSpotM: drawn as an expressive multi-character freeze-frame scene. */
  same: boolean;
}

/**
 * Advances every time CrewMap opens or returns to the foreground so crewmates at the same spot strike a fresh
 * freeze-frame fun pose from the 600+ pose library each time you open to it!
 */
export const usePoseSeed = create<{ seed: number; next: () => void }>((set) => ({
  seed: Math.floor(Math.random() * 1_000_000) + 1,
  next: () => set((s) => ({ seed: (s.seed + 1) % 10_000_000 || 1 })),
}));

AppState.addEventListener('change', (st) => {
  if (st === 'active') usePoseSeed.getState().next();
});

const ANCHOR = { x: 0.5, y: 0.85 };
const SCENE_W = 152;
const SCENE_H = 106;

/** Expressive 3D freeze-frame group pose (supports both friends and `me` when together at the same spot!). */
const GroupScene = memo(function GroupScene({ ids, max }: { ids: string[]; max: number }) {
  const friends = useApp((s) => s.friends);
  const me = useApp((s) => s.me);
  const seed = usePoseSeed((s) => s.seed);
  useEffect(() => {
    // Also pick a fresh freeze-frame when a new cluster mounts on the map.
    usePoseSeed.getState().next();
  }, []);
  const scene = useMemo(() => pickGroupPose(ids.slice().sort().slice(0, max), seed), [ids, max, seed]);
  const n = scene.members.length;
  const size = n <= 2 ? 60 : n <= 4 ? 52 : 44;
  const slots = scene.pose.slots
    .map((s, i) => ({ s, id: scene.members[i]! }))
    .sort((a, b) => a.s.z - b.s.z);
  return (
    <View style={{ width: SCENE_W, height: SCENE_H }}>
      {slots.map(({ s, id }) => {
        const profile = friends[id]?.profile ?? (me?.deviceId === id ? me : null);
        if (!profile) return null;
        const sz = Math.round(size * s.scale);
        const jumpPx = Math.round(s.jump * 20);
        return (
          <View
            key={id}
            style={{
              position: 'absolute',
              left: SCENE_W / 2 + s.x * (SCENE_W / 2 - sz * 0.48) - sz / 2,
              top: SCENE_H / 2 + s.y * (SCENE_H / 2 - sz * 0.52) - sz / 2 - jumpPx,
              transform: [{ rotate: `${s.rot}deg` }, { scaleX: s.mirror ? -1 : 1 }],
            }}
          >
            <PosedSprite avatar={profile.avatar} frame={s.frame} action={s.action} heading={s.heading} size={sz} />
          </View>
        );
      })}
    </View>
  );
});

export const ClusterMarker = memo(function ClusterMarker({
  c,
  driving,
  onPress,
}: {
  c: CrewCluster;
  driving: boolean;
  onPress: (c: CrewCluster) => void;
}) {
  const friends = useApp((s) => s.friends);
  const me = useApp((s) => s.me);
  const fix = useApp((s) => s.fix);
  const coord = useMemo(() => {
    const pts = c.ids.flatMap((id) => {
      if (friends[id]?.presence) return [friends[id]!.presence!];
      if (me?.deviceId === id && fix) return [{ lat: fix.lat, lng: fix.lng }];
      return [];
    });
    const m = centroid(pts.length ? pts : [{ lat: 0, lng: 0 }]);
    return [m.lng, m.lat];
  }, [c.ids, friends, me?.deviceId, fix?.lat, fix?.lng]);
  const leadProfile = friends[c.ids[0]!]?.profile ?? (me?.deviceId === c.ids[0] ? me : null);
  const nameList = c.ids
    .map((id) => (me?.deviceId === id ? t('circle.you') : (friends[id]?.profile.name ?? '')))
    .filter(Boolean);
  const names = nameList.join(', ');
  const chipLabel = nameList.length <= 2 ? nameList.join(' & ') : `${nameList[0]} +${nameList.length - 1}`;

  return (
    <MarkerView coordinate={coord} allowOverlap allowOverlapWithPuck anchor={ANCHOR}>
      <View
        testID={`crew-cluster-${c.ids.length}`}
        accessible
        accessibilityRole="button"
        accessibilityLabel={names}
        onTouchEnd={() => onPress(c)}
        style={styles.wrap}
      >
        {c.same ? (
          <GroupScene ids={c.ids} max={driving ? CLUSTER.sceneMaxDriving : CLUSTER.sceneMax} />
        ) : leadProfile ? (
          <AvatarStill avatar={leadProfile.avatar} size={driving ? 44 : 56} />
        ) : null}
        <View style={styles.chipRow}>
          <Text style={styles.chipText} numberOfLines={1}>
            {chipLabel}
          </Text>
          <View style={[styles.countInline, driving && styles.countSmall]}>
            <Text style={styles.countText}>{c.ids.length}</Text>
          </View>
        </View>
      </View>
    </MarkerView>
  );
});

/** Everyone in a cluster; tapping a friend opens their sheet, tapping yourself opens your avatar editor. */
export function ClusterSheet({
  ids,
  onClose,
  onOpen,
  onOpenSelf,
}: {
  ids: string[] | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onOpenSelf?: () => void;
}) {
  const th = useTheme();
  const me = useApp((s) => s.me);
  return (
    <Modal visible={ids !== null} transparent animationType="slide" statusBarTranslucent supportedOrientations={['portrait', 'landscape']} onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('common.cancel')} style={styles.scrim} onPress={onClose} />
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: th.card }]}>
          <FlatList
            testID="cluster-list"
            data={ids ?? []}
            keyExtractor={(id) => id}
            renderItem={({ item }) =>
              me && item === me.deviceId ? (
                <Pressable
                  testID={`cluster-row-${item}`}
                  onPress={() => {
                    onClose();
                    onOpenSelf?.();
                  }}
                  style={[styles.selfRow, { borderBottomColor: th.separator }]}
                >
                  <AvatarStill avatar={me.avatar} size={44} />
                  <Text style={[type.headline, font('bold'), { color: th.text, flex: 1 }]}>{`${me.name} (${t('circle.you')})`}</Text>
                  <Icon name="chevronRight" size={18} color={th.textSoft} />
                </Pressable>
              ) : (
                <View testID={`cluster-row-${item}`}>
                  <LiveRow id={item} onOpen={(f) => onOpen(f.profile.deviceId)} onActions={(f) => onOpen(f.profile.deviceId)} />
                </View>
              )
            }
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  chipRow: {
    marginTop: -6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(14,18,32,0.86)',
    borderRadius: 999,
    paddingLeft: 9,
    paddingRight: 5,
    paddingVertical: 2,
    maxWidth: 164,
  },
  chipText: { color: '#fff', fontSize: 12, fontWeight: '800', flexShrink: 1 },
  countInline: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: '#5B6CFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countSmall: { minWidth: 16, height: 16, borderRadius: 8 },
  countText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, maxHeight: '60%', paddingVertical: 12 },
  selfRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
