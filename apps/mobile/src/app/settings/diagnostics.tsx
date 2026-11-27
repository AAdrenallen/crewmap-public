import { ScrollView, Share, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@crewmap/shared/i18n';
import { dayKey } from '@crewmap/shared/apiBudget';
import { useApiBudget } from '../../core/apiBudget';
import { clearErrors, errorsText, useErrorLog } from '../../core/errorLog';
import { Button, Card } from '../../ui/kit';
import { pageX, useLayoutMode } from '../../ui/layout';
import { ScreenHeader } from '../../ui/screens-common/Layout';
import { type, useTheme } from '../../ui/theme';

/** Scrubbed on-device error log: view, share, clear. */
export default function Diagnostics() {
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  const entries = useErrorLog((s) => s.entries);
  const today = useApiBudget((s) => s.days.find((d) => d.day === dayKey(Date.now())));
  const kinds = [...new Set([...Object.keys(today?.used ?? {}), ...Object.keys(today?.saved ?? {})])] as string[];
  return (
    <ScrollView style={{ backgroundColor: th.bg }} contentContainerStyle={{ ...pageX(lay), paddingTop: insets.top + 8, gap: 12, paddingBottom: insets.bottom + 30 }}>
      <ScreenHeader title={t('diag.title')} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button testID="diag-share" kind="secondary" label={t('diag.share')} onPress={() => void Share.share({ message: errorsText() || t('diag.empty') })} />
        <Button testID="diag-clear" kind="ghost" label={t('diag.clear')} onPress={clearErrors} />
      </View>
      {kinds.length > 0 ? (
        <Card style={{ gap: 4 }}>
          <Text style={[type.caption, { color: th.textFaint }]}>{t('diag.api')}</Text>
          {kinds.map((k) => (
            <Text key={k} style={[type.small, { color: th.text }]}>{`${k}: ${(today?.used as Record<string, number> | undefined)?.[k] ?? 0} / ${(today?.saved as Record<string, number> | undefined)?.[k] ?? 0}`}</Text>
          ))}
        </Card>
      ) : null}
      {entries.length === 0 ? (
        <Text testID="diag-empty" style={[type.small, { color: th.textSoft }]}>
          {t('diag.empty')}
        </Text>
      ) : (
        [...entries].reverse().map((e, i) => (
          <Card key={`${e.t}-${i}`} style={{ gap: 4 }}>
            <Text style={[type.caption, { color: th.textFaint }]}>{`${new Date(e.t).toISOString().slice(0, 19)} · ${e.kind} · ${e.route ?? '-'}`}</Text>
            <Text style={[type.small, { color: th.text }]}>{e.msg}</Text>
            {e.stack ? <Text style={[type.caption, { color: th.textSoft }]}>{e.stack}</Text> : null}
          </Card>
        ))
      )}
    </ScrollView>
  );
}
