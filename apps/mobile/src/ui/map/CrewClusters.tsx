import { memo, useMemo } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { MarkerView } from '@rnmapbox/maps';
import { CLUSTER, centroid } from '@crewmap/shared/crewCluster';
import { pickGroupPose } from '@crewmap/shared/groupPoses';
import { t } from '@crewmap/shared/i18n';
import { useApp } from '../../core/store';
import { LiveRow } from '../home/FriendCard';
import { radius, useTheme } from '../theme';
import { AvatarStill, PosedSprite } from './Sprites';

export interface CrewCluster {
  ids: string[];
  /** Everyone within CLUSTER.sameSpotM: drawn as a group scene. */
  same: boolean;
}

const ANCHOR = { x: 0.5, y: 0.85 };
const SCENE_W = 112;
const SCENE_H = 84;

/** A frozen group pose from each member's existing walk sheet (2D transforms only, no 3D work). */
const GroupScene = memo(function GroupScene({ ids, max }: { ids: string[]; max: number }) {
  const friends = useApp((s) => s.friends);
  const scene = useMemo(() => pickGroupPose(ids.slice().sort().slice(0, max)), [ids, max]);
  const n = scene.members.length;
  const size = n <= 3 ? 52 : n <= 5 ? 44 : 38;
  const slots = scene.pose.slots
    .map((s, i) => ({ s, id: scene.members[i]! }))
    .sort((a, b) => a.s.z - b.s.z);
  return (
    <View style={{ width: SCENE_W, height: SCENE_H }}>
      {slots.map(({ s, id }) => {
        const f = friends[id];
        if (!f) return null;
        const sz = size * s.scale;
        return (
          <View
            key={id}
            style={{
              position: 'absolute',
              left: SCENE_W / 2 + s.x * (SCENE_W / 2 - sz / 2) - sz / 2,
              top: SCENE_H / 2 + s.y * (SCENE_H / 2 - sz / 2) - sz / 2,
              transform: [{ rotate: `${s.rot}deg` }, { scaleX: s.mirror ? -1 : 1 }],
            }}
          >
            <PosedSprite avatar={f.profile.avatar} frame={s.frame} heading={s.heading} size={sz} />
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
  const coord = useMemo(() => {
    const pts = c.ids.flatMap((id) => (friends[id]?.presence ? [friends[id]!.presence!] : []));
    const m = centroid(pts);
    return [m.lng, m.lat];
  }, [c.ids, friends]);
  const lead = friends[c.ids[0]!];
  const names = c.ids.map((id) => friends[id]?.profile.name ?? '').join(', ');
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
        ) : lead ? (
          <AvatarStill avatar={lead.profile.avatar} size={driving ? 44 : 56} />
        ) : null}
        <View style={[styles.count, driving && styles.countSmall]}>
          <Text style={styles.countText}>{c.ids.length}</Text>
        </View>
      </View>
    </MarkerView>
  );
});

/** Everyone in a cluster that max zoom cannot separate; a row opens the usual crewmate screen. */
export function ClusterSheet({ ids, onClose, onOpen }: { ids: string[] | null; onClose: () => void; onOpen: (id: string) => void }) {
  const th = useTheme();
  return (
    <Modal visible={ids !== null} transparent animationType="slide" statusBarTranslucent supportedOrientations={['portrait', 'landscape']} onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('common.cancel')} style={styles.scrim} onPress={onClose} />
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: th.card }]}>
          <FlatList
            testID="cluster-list"
            data={ids ?? []}
            keyExtractor={(id) => id}
            renderItem={({ item }) => (
              <View testID={`cluster-row-${item}`}>
                <LiveRow
                  id={item}
                  onOpen={(f) => onOpen(f.profile.deviceId)}
                  onActions={(f) => onOpen(f.profile.deviceId)}
                />
              </View>
            )}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', padding: 4 },
  count: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 6,
    backgroundColor: 'rgba(14,18,32,0.9)',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countSmall: { minWidth: 20, height: 20, borderRadius: 10 },
  countText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  sheet: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '60%',
    borderTopLeftRadius: radius.l,
    borderTopRightRadius: radius.l,
    paddingVertical: 12,
  },
});
