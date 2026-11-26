import { useMemo, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { routeHazardRows } from '@crewmap/hazards';
import { lang, t } from '@crewmap/shared/i18n';
import type { NavRoute } from '@crewmap/shared/navigation';
import { formatDistance } from '@crewmap/shared/units';
import { useApp } from '../../core/store';
import { Bouncy, Icon } from '../kit';
import { HAZARD_ICON } from '../map/hazardIcons';
import { font, radius, type as typo, useTheme } from '../theme';
import { ageText } from './age';

/** "N hazards on this route", expandable into type / distance along the route / age rows. Hidden when there are none. */
export function RouteHazards({ route }: { route: NavRoute }) {
  const th = useTheme();
  const router = useRouter();
  const hazards = useApp((s) => s.hazards);
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => routeHazardRows(route.geometry, hazards, Date.now()), [route, hazards]);
  if (rows.length === 0) return null;
  return (
    <View style={[styles.box, { borderColor: th.border, backgroundColor: th.cardAlt }]}>
      <Bouncy
        testID="route-hazards"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={rows.length === 1 ? t('route.hazardsOne') : t('route.hazards', { n: rows.length })}
        onPress={() => setOpen((o) => !o)}
        style={styles.head}
      >
        <Icon name="alert" size={18} color={th.warn} />
        <Text style={[typo.small, font('bold'), { color: th.text, flex: 1 }]}>{rows.length === 1 ? t('route.hazardsOne') : t('route.hazards', { n: rows.length })}</Text>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <Icon name="chevronDown" size={18} color={th.textSoft} />
        </View>
      </Bouncy>
      {open &&
        rows.map((r) => (
          <Bouncy key={r.id} testID={`route-hazard-${r.id}`} accessibilityLabel={t(`hz.${r.type}`)} onPress={() => router.push({ pathname: '/hazard/[id]', params: { id: r.id } })} style={styles.row}>
            <Image source={HAZARD_ICON[r.type]} style={{ width: 22, height: 28 }} resizeMode="contain" />
            <View style={{ flex: 1 }}>
              <Text style={[typo.small, font('medium'), { color: th.text }]} numberOfLines={1}>
                {t(`hz.${r.type}`)}
              </Text>
              <Text style={[typo.caption, { color: th.textSoft }]} numberOfLines={1}>
                {formatDistance(r.alongM, lang())} · {ageText(r.age)}
              </Text>
            </View>
          </Bouncy>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.m, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 48 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 8 },
});
