import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { customFromSummary, DEFAULT_SHARING, resolveShare, shareSummary, shareUserMode, type ShareUserMode, type SharingPolicy, type UserOverride } from '@crewmap/p2p';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { Segmented } from '../kit';
import { palette } from '../theme';
import { Group, ListRow } from '../screens-common/Layout';
import { LOCATION_ICON, ShareFields, type ShareFlag } from './ShareFields';

/** Per-friend fields (UserOverride): places, emotes and chat stay crew-wide (D52). */
const FLAGS: ShareFlag[] = ['speed', 'battery', 'driveAlong', 'stats', 'trips', 'checkIn'];

/**
 * "Share with {name}" (D56): Same as crew (read-only summary of what they see now, from the most permissive shared
 * crew) or Custom (a full per-friend override, same rows as the crew screen). Back to Same as crew clears it.
 */
export function ShareUserRow({ friendId, name }: { friendId: string; name: string }) {
  const ov = useApp((s) => s.shareOverrides[friendId]);
  const crews = useApp((s) => s.crews);
  const sharing = useApp((s) => s.sharing);
  const mine = useMemo(() => crews.filter((c) => c.memberIds.includes(friendId)).map((c) => ({ id: c.id, pol: sharing[c.id] ?? DEFAULT_SHARING })), [crews, sharing, friendId]);
  const sum = shareSummary(mine, ov);
  const mode = shareUserMode(ov);
  const from = crews.find((c) => c.id === sum.fromCrew)?.name;
  const setMode = (m: ShareUserMode) => {
    if (m === mode) return;
    void engine.crews.setOverride(friendId, m === 'custom' ? customFromSummary(shareSummary(mine, null)) : {});
  };
  // Custom edits show the override over the first shared crew; every field is pinned, so the crew part never shows.
  const shown: SharingPolicy = resolveShare(mine[0]?.pol ?? DEFAULT_SHARING, ov);
  const edit = (p: Partial<SharingPolicy>) => {
    const next: UserOverride = { ...ov };
    for (const [k, v] of Object.entries(p)) (next as Record<string, unknown>)[k] = v;
    void engine.crews.setOverride(friendId, next);
  };
  const on = (v: boolean) => t(v ? 'common.on' : 'common.off');

  return (
    <View testID={`share-user-${friendId}`} style={styles.box}>
      <Group title={t('share.with', { name })}>
        <View style={{ padding: 12 }}>
          <Segmented
            testIDPrefix="share-user-mode-"
            value={mode}
            onChange={setMode}
            options={[
              { key: 'crew', label: t('share.sameAsCrew') },
              { key: 'custom', label: t('share.custom') },
            ]}
          />
        </View>
        {mode === 'crew' && (
          <>
            <ListRow
              testID="share-user-sum-location"
              icon={LOCATION_ICON[sum.location]}
              tint={sum.location === 'hidden' ? palette.grey : palette.brand}
              label={t(`share.${sum.location}`)}
              value={from}
            />
            <ListRow testID="share-user-sum-speed" icon="speed" tint={palette.grey} label={t('share.speed')} value={on(sum.speed)} />
            <ListRow testID="share-user-sum-battery" icon="battery" tint={palette.grey} label={t('share.battery')} value={on(sum.battery)} />
            <ListRow testID="share-user-sum-stats" icon="trophy" tint={palette.grey} label={t('share.stats')} value={on(sum.stats)} />
            <ListRow testID="share-user-sum-checkIn" icon="shield" tint={palette.grey} label={t('checkIn.title')} value={on(sum.checkIn)} last />
          </>
        )}
      </Group>
      {mode === 'custom' && <ShareFields value={shown} flags={FLAGS} onChange={edit} title={name} idPrefix="share-user-" locPrefix="share-user-loc-" visPrefix="share-user-vis-" />}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 16 },
});
