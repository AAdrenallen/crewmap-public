import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_SHARING, type SharingPolicy } from '@crewmap/p2p';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { pageX, useLayoutMode } from '../../ui/layout';
import { palette, useTheme } from '../../ui/theme';
import { Group, ListRow, ScreenHeader } from '../../ui/screens-common/Layout';
import { ShareFields, type ShareFlag } from '../../ui/share/ShareFields';
import { ShareUserRow } from '../../ui/share/ShareUserRow';

const FLAGS: ShareFlag[] = ['speed', 'battery', 'stats', 'trips', 'places', 'emotes', 'chat', 'checkIn'];

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
      <ShareFields value={pol} flags={FLAGS} onChange={set} />
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
                  last={i === members.length - 1}
                />
              </View>
            );
          })}
        </Group>
      )}
      {open && members.includes(open) && <ShareUserRow friendId={open} name={friends[open]?.profile.name ?? ''} />}
    </ScrollView>
  );
}
