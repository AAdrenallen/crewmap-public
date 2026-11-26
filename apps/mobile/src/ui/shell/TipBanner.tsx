import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { t } from '@crewmap/shared/i18n';
import { markTipSeen, tipForScreen, TIPS, type PromptScreen, type TipId } from '@crewmap/shared/shell';
import { kvGet, kvSet } from '../../core/db';
import { useApp } from '../../core/store';
import { IconButton, Icon } from '../kit';
import { radius, type, useTheme } from '../theme';

export const TIPS_SEEN_KEY = 'tipsSeen';

/** Settings → Tips: forget which first-time prompts were dismissed. */
export async function resetTips(): Promise<void> {
  await kvSet(TIPS_SEEN_KEY, []);
}

/** Compact, non-blocking, dismissible first-time banner. Renders only on the secondary screen that owns the feature, once, never while driving or navigating. */
export function TipBanner({ screen }: { screen: PromptScreen }) {
  const th = useTheme();
  const busy = useApp((s) => s.driving || s.nav?.active === true);
  const [seen, setSeen] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void kvGet<string[]>(TIPS_SEEN_KEY, [])
      .then((v) => live && setSeen(v))
      .catch(() => live && setSeen([]));
    return () => {
      live = false;
    };
  }, []);
  const id: TipId | null = seen ? tipForScreen(screen, seen, busy) : null;
  if (!id || !seen) return null;
  const tip = TIPS.find((x) => x.id === id)!;
  const dismiss = () => {
    const next = markTipSeen(seen, id);
    setSeen(next);
    void kvSet(TIPS_SEEN_KEY, next).catch(() => undefined);
  };
  return (
    <View testID="tip-banner" style={[styles.card, { backgroundColor: th.card, borderColor: th.border }]}>
      <Icon name={tip.icon} size={22} color={th.accent} />
      <Text style={[type.small, { color: th.text, flex: 1 }]}>{t(`tips.${id}.b`)}</Text>
      <IconButton testID="tip-dismiss" icon="close" tone="plain" label={t('tips.gotIt')} onPress={dismiss} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radius.l, paddingLeft: 12, borderWidth: StyleSheet.hairlineWidth },
});
