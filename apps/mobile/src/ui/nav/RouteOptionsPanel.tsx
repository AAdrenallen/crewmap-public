import { View } from 'react-native';
import { t } from '@crewmap/shared/i18n';
import type { RouteOptions } from '@crewmap/shared/navigation';
import { Card, Toggle } from '../kit';

/** Avoid tolls / highways / ferries. The owner persists the value and re-requests routes on change. */
export function RouteOptionsPanel({ value, onChange }: { value: RouteOptions; onChange: (o: RouteOptions) => void }) {
  return (
    <Card flat style={{ paddingVertical: 0 }}>
      <View>
        <Toggle testID="opt-tolls" label={t('route.avoidTolls')} value={value.avoidTolls} onChange={(v) => onChange({ ...value, avoidTolls: v })} />
        <Toggle testID="opt-highways" label={t('route.avoidHighways')} value={value.avoidHighways} onChange={(v) => onChange({ ...value, avoidHighways: v })} />
        <Toggle testID="opt-ferries" label={t('route.avoidFerries')} value={value.avoidFerries} onChange={(v) => onChange({ ...value, avoidFerries: v })} />
      </View>
    </Card>
  );
}
