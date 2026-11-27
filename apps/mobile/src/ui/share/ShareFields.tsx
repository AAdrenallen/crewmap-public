import { View } from 'react-native';
import type { LocationShare, SharingPolicy } from '@crewmap/p2p';
import { t } from '@crewmap/shared/i18n';
import type { StatsVisibility } from '@crewmap/shared/stats';
import { Segmented } from '../kit';
import { palette } from '../theme';
import { Group, SwitchRow } from '../screens-common/Layout';
import type { IconName } from '../screens-common/Icon';

export type ShareFlag = 'speed' | 'battery' | 'driveAlong' | 'stats' | 'trips' | 'places' | 'emotes' | 'chat' | 'checkIn';

export const LOCATIONS: LocationShare[] = ['exact', 'approx', 'city', 'hidden'];
export const LOCATION_ICON: Record<LocationShare, IconName> = { exact: 'locate', approx: 'pin', city: 'city', hidden: 'ghost' };

const FLAG: Record<ShareFlag, { icon: IconName; label: () => string }> = {
  speed: { icon: 'speed', label: () => t('share.speed') },
  battery: { icon: 'battery', label: () => t('share.battery') },
  driveAlong: { icon: 'car', label: () => t('share.driveAlong') },
  stats: { icon: 'trophy', label: () => t('share.stats') },
  trips: { icon: 'road', label: () => t('share.trips') },
  places: { icon: 'pin', label: () => t('share.places') },
  emotes: { icon: 'heart', label: () => t('share.emotes') },
  chat: { icon: 'popup', label: () => t('share.chat') },
  checkIn: { icon: 'shield', label: () => t('checkIn.title') },
};

/** Stats fields (D52/D56). `trips` is the Trips switch, so it has no row of its own. */
const VIS: { key: Exclude<keyof StatsVisibility, 'trips'>; icon: IconName; label: () => string }[] = [
  { key: 'score', icon: 'shield', label: () => t('stats.trend') },
  { key: 'distance', icon: 'road', label: () => t('stats.driven') },
  { key: 'topSpeed', icon: 'speed', label: () => t('stats.top') },
  { key: 'events', icon: 'warning', label: () => t('stats.events') },
  { key: 'places', icon: 'pin', label: () => t('stats.places') },
  { key: 'streaks', icon: 'flame', label: () => t('stats.streak') },
  { key: 'badges', icon: 'trophy', label: () => t('stats.badges') },
  { key: 'home', icon: 'home', label: () => t('lb.cat.homeRuns') },
];

type Value = Pick<SharingPolicy, 'location' | 'statsVis'> & Partial<Record<ShareFlag, boolean>>;

/**
 * The location level + data switches + stats fields, shared by the crew screen and a friend's Custom mode (D56) so
 * both read the same. `flags` picks the switches the target supports.
 */
export function ShareFields({ value, flags, onChange, title, idPrefix = 'share-', locPrefix = 'seg-', visPrefix = 'vis-' }: { value: Value; flags: ShareFlag[]; onChange: (p: Partial<SharingPolicy>) => void; title?: string; idPrefix?: string; locPrefix?: string; visPrefix?: string }) {
  return (
    <>
      <Group title={t('share.location')}>
        <View style={{ padding: 12 }}>
          <Segmented testIDPrefix={locPrefix} value={value.location} onChange={(v) => onChange({ location: v })} options={LOCATIONS.map((k) => ({ key: k, label: t(`share.${k}`) }))} />
        </View>
      </Group>
      <Group title={title ?? t('crew.sees')} index={1}>
        {flags.map((k, i) => (
          <SwitchRow key={k} testID={`${idPrefix}${k}`} icon={FLAG[k].icon} label={FLAG[k].label()} value={!!value[k]} onChange={(v) => onChange({ [k]: v })} last={i === flags.length - 1} />
        ))}
      </Group>
      {value.stats && (
        <Group title={t('share.stats')} index={2}>
          {VIS.map((v, i) => (
            <SwitchRow
              key={v.key}
              testID={`${visPrefix}${v.key}`}
              icon={v.icon}
              tint={palette.mint}
              label={v.label()}
              value={value.statsVis[v.key]}
              onChange={(on) => onChange({ statsVis: { ...value.statsVis, [v.key]: on } })}
              last={i === VIS.length - 1}
            />
          ))}
        </Group>
      )}
    </>
  );
}
