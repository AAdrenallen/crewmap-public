import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_SHARING, type LocationShare, type SharingPolicy } from '@crewmap/p2p';
import { t } from '@crewmap/shared/i18n';
import type { StatsVisibility } from '@crewmap/shared/stats';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { Segmented } from '../../ui/kit';
import { pageX, useLayoutMode } from '../../ui/layout';
import { palette, useTheme } from '../../ui/theme';
import { Group, ListRow, ScreenHeader, SwitchRow } from '../../ui/screens-common/Layout';
import type { IconName } from '../../ui/screens-common/Icon';
import { ShareUserRow } from '../../ui/share/ShareUserRow';

type Flag = Exclude<keyof SharingPolicy, 'location' | 'statsVis' | 'driveAlong'>;

const FLAGS: { key: Flag; icon: IconName; label: () => string }[] = [
  { key: 'speed', icon: 'speed', label: () => t('share.speed') },
  { key: 'battery', icon: 'battery', label: () => t('share.battery') },
  { key: 'stats', icon: 'trophy', label: () => t('share.stats') },
  { key: 'trips', icon: 'car', label: () => t('share.trips') },
  { key: 'places', icon: 'pin', label: () => t('share.places') },
  { key: 'emotes', icon: 'heart', label: () => t('share.emotes') },
  { key: 'chat', icon: 'popup', label: () => t('share.chat') },
];

/** Stats fields per crew (D52). `trips` is the crew's Trips switch above, so it has no row of its own. */
const VIS: { key: Exclude<keyof StatsVisibility, 'trips'>; icon: IconName; label: () => string }[] = [
  { key: 'score', icon: 'shield', label: () => t('stats.trend') },
  { key: 'distance', icon: 'road', label: () => t('stats.driven') },
  { key: 'topSpeed', icon: 'speed', label: () => t('stats.top') },
  { key: 'events', icon: 'warning', label: () => t('stats.events') },
  { key: 'places', icon: 'pin', label: () => t('stats.places') },
  { key: 'streaks', icon: 'flame', label: () => t('stats.streak') },
  { key: 'badges', icon: 'trophy', label: () => t('stats.badges') },
];

const LOCATIONS: LocationShare[] = ['exact', 'approx', 'city', 'hidden'];

/** What THIS phone reveals to one crew, and per member overrides (enforced before anything is encrypted and sent). */
export default function CrewSharing() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const lay = useLayoutMode();
  const crew = useApp((s) => s.crews.find((c) => c.id === id));
  const pol = useApp((s) => s.sharing[id]) ?? DEFAULT_SHARING;
  const friends = useApp((s) => s.allFriends);
  const overrides = useApp((s) => s.shareOverrides);
  const myId = engine.me.deviceId;
  const [open, setOpen] = useState<string | null>(null);
  const set = (p: Partial<SharingPolicy>) => void engine.crews.setPolicy(id, p);
  const members = (crew?.memberIds ?? []).filter((m) => m !== myId);

  return (
    <ScrollView style={{ backgroundColor: th.bg }} contentContainerStyle={{ ...pageX(lay), paddingTop: insets.top + 8, gap: 16, paddingBottom: insets.bottom + 30 }}>
      <ScreenHeader title={crew?.name ?? t('crew.sees')} />
      <Group title={t('share.location')}>
        <View style={{ padding: 12 }}>
          <Segmented value={pol.location} onChange={(v) => set({ location: v })} options={LOCATIONS.map((k) => ({ key: k, label: t(`share.${k}`) }))} />
        </View>
      </Group>
      <Group title={t('crew.sees')} index={1}>
        {FLAGS.map((f, i) => (
          <SwitchRow key={f.key} testID={`share-${f.key}`} icon={f.icon} label={f.label()} value={pol[f.key]} onChange={(v) => set({ [f.key]: v })} last={i === FLAGS.length - 1} />
        ))}
      </Group>
      {pol.stats && (
        <Group title={t('share.stats')} index={2}>
          {VIS.map((v, i) => (
            <SwitchRow
              key={v.key}
              testID={`vis-${v.key}`}
              icon={v.icon}
              tint={palette.mint}
              label={v.label()}
              value={pol.statsVis[v.key]}
              onChange={(on) => set({ statsVis: { ...pol.statsVis, [v.key]: on } })}
              last={i === VIS.length - 1}
            />
          ))}
        </Group>
      )}
      {members.length > 0 && (
        <Group title={t('crew.members')} index={3}>
          {members.map((m, i) => {
            const name = friends[m]?.profile.name ?? '';
            return (
              <View key={m}>
                <ListRow
                  testID={`share-user-open-${i}`}
                  icon={overrides[m] ? 'sliders' : 'user'}
                  tint={overrides[m] ? palette.brand : palette.grey}
                  label={name}
                  onPress={() => setOpen(open === m ? null : m)}
                  last={i === members.length - 1 && open !== m}
                />
                {open === m && <ShareUserRow friendId={m} name={name} />}
              </View>
            );
          })}
        </Group>
      )}
    </ScrollView>
  );
}
