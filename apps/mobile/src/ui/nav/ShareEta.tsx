import { useState } from 'react';
import { ScrollView, Share, View } from 'react-native';
import { crewThread } from '@crewmap/p2p';
import { t } from '@crewmap/shared/i18n';
import type { NavRoute } from '@crewmap/shared/navigation';
import { formatClock, formatMinutes } from '@crewmap/shared/units';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { Button, Chip, Toast } from '../kit';

/** Share the selected route's ETA to a friend / crew chat, or through the system share sheet. */
export function ShareEta({ route, destName }: { route: NavRoute; destName: string }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<'sent' | 'failed' | null>(null);
  const crews = useApp((s) => s.crews);
  const friends = useApp((s) => s.allFriends);

  const message = () => t('route.etaMsg', { dest: destName, time: formatClock(Date.now() + route.durationS * 1000), min: formatMinutes(route.durationS) });
  const done = (ok: boolean) => {
    setResult(ok ? 'sent' : 'failed');
    setOpen(false);
    setTimeout(() => setResult(null), 3000);
  };
  const toThread = async (thread: string) => {
    done(await engine.chat.send(thread, message()).catch(() => false));
  };
  const system = () => {
    setOpen(false);
    void Share.share({ message: message() }).catch(() => undefined);
  };

  return (
    <View style={{ gap: 8 }}>
      <Button testID="route-share-eta" kind="secondary" compact icon="share" label={t('route.shareEta')} onPress={() => setOpen((o) => !o)} />
      {open && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
          {crews.map((c) => (
            <Chip key={c.id} testID={`eta-crew-${c.id}`} icon="crew" label={c.name} onPress={() => void toThread(crewThread(c.id))} />
          ))}
          {Object.values(friends).map((f) => (
            <Chip key={f.profile.deviceId} testID={`eta-friend-${f.profile.deviceId}`} icon="person" label={f.profile.name} onPress={() => void toThread(f.profile.deviceId)} />
          ))}
          <Chip testID="eta-system" icon="share" label={t('route.shareOther')} onPress={system} />
        </ScrollView>
      )}
      {result && <Toast message={t(result === 'sent' ? 'route.etaSent' : 'route.etaFailed')} icon={result === 'sent' ? 'check' : 'alert'} tone={result === 'sent' ? 'neutral' : 'danger'} style={{ alignSelf: 'center' }} />}
    </View>
  );
}
