import { StyleSheet, Text, View } from 'react-native';
import type { LocationShare, UserOverride } from '@crewmap/p2p';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { Chip } from '../kit';
import type { IconName } from '../kitIcons';
import { type as typo, useTheme } from '../theme';

const LOCATIONS: LocationShare[] = ['exact', 'approx', 'city', 'hidden'];
type Flag = Exclude<keyof UserOverride, 'location'>;
const FLAGS: { key: Flag; icon: IconName; label: () => string }[] = [
  { key: 'speed', icon: 'speed', label: () => t('share.speed') },
  { key: 'battery', icon: 'battery', label: () => t('share.battery') },
  { key: 'driveAlong', icon: 'car', label: () => t('share.driveAlong') },
];

/** Crew default → on → off → crew default. */
const nextFlag = (v: boolean | undefined): boolean | undefined => (v === undefined ? true : v ? false : undefined);

/**
 * "Share with {name}" (D52): one friend's override of the crew policies, as chips. A highlighted chip is an override;
 * the location "crew" chip and plain flag chips follow each crew's own level.
 */
export function ShareUserRow({ friendId, name }: { friendId: string; name: string }) {
  const th = useTheme();
  const ov = useApp((s) => s.shareOverrides[friendId]) ?? {};
  const set = (p: UserOverride) => void engine.crews.setOverride(friendId, { ...ov, ...p });
  return (
    <View testID={`share-user-${friendId}`} style={styles.box}>
      <Text style={[typo.small, { color: th.textSoft }]} numberOfLines={1}>
        {t('share.with', { name })}
      </Text>
      <View style={styles.row}>
        <Chip testID="share-user-loc-default" icon="users" label={t('share.crewDefault')} active={ov.location === undefined} onPress={() => set({ location: undefined })} />
        {LOCATIONS.map((k) => (
          <Chip key={k} testID={`share-user-loc-${k}`} label={t(`share.${k}`)} active={ov.location === k} onPress={() => set({ location: k })} />
        ))}
      </View>
      <View style={styles.row}>
        {FLAGS.map((f) => {
          const v = ov[f.key];
          return (
            <Chip
              key={f.key}
              testID={`share-user-${f.key}`}
              icon={v === undefined ? f.icon : v ? 'check' : 'close'}
              label={f.label()}
              active={v !== undefined}
              onPress={() => set({ [f.key]: nextFlag(v) })}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
