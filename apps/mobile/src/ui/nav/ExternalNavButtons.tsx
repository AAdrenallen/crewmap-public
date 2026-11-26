import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { platform, type ExternalNavApp } from '@crewmap/platform';
import type { LatLng } from '@crewmap/shared/geo';
import { t } from '@crewmap/shared/i18n';
import type { NavRoute } from '@crewmap/shared/navigation';
import { shapingWaypoints } from '@crewmap/shared/navigation/externalNav';
import { markExternalNavLaunched } from '../../core/overlay';
import { Bouncy, Icon, type IconName } from '../kit';
import { hit, radius, space, type as typo, useTheme } from '../theme';

const APPS: { app: ExternalNavApp; icon: IconName; label: () => string }[] = [
  { app: 'waze', icon: 'compass', label: () => t('nav.extWaze') },
  { app: 'gmaps', icon: 'route', label: () => t('nav.extGmaps') },
];

/** Hand the chosen route to an installed Waze / Google Maps (Google keeps the route via shaping waypoints). */
export function ExternalNavButtons({ route, destination, others = [] }: { route: NavRoute; destination: LatLng; others?: NavRoute[] }) {
  const th = useTheme();
  const [installed, setInstalled] = useState<ExternalNavApp[]>([]);

  useEffect(() => {
    let alive = true;
    platform.externalNav
      .available()
      .then((a) => alive && setInstalled(a))
      .catch(() => alive && setInstalled([]));
    return () => {
      alive = false;
    };
  }, []);

  const shown = APPS.filter((a) => installed.includes(a.app));
  if (shown.length === 0) return null;

  const launch = async (app: ExternalNavApp) => {
    const via = app === 'gmaps' ? shapingWaypoints(route, others) : [];
    if (await platform.externalNav.launch(app, destination, via)) markExternalNavLaunched();
  };

  return (
    <View style={styles.row}>
      {shown.map((a) => (
        <Bouncy
          key={a.app}
          testID={`extnav-${a.app}`}
          accessibilityRole="button"
          accessibilityLabel={a.app === 'waze' ? `${a.label()}, ${t('nav.extApprox')}` : a.label()}
          onPress={() => void launch(a.app)}
          style={[styles.btn, { backgroundColor: th.cardAlt, borderColor: th.border }]}
        >
          <Icon name={a.icon} size={18} color={th.text} />
          <Text style={[typo.small, { color: th.text }]} numberOfLines={1}>
            {a.label()}
          </Text>
          {a.app === 'waze' && (
            <View accessibilityLabel={t('nav.extApprox')} style={[styles.hint, { backgroundColor: th.warn }]}>
              <Icon name="shuffle" size={10} color={th.onAccent} strokeWidth={2.5} />
            </View>
          )}
        </Bouncy>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space(2) },
  btn: {
    flex: 1,
    minHeight: hit,
    borderRadius: radius.m,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space(1.5),
    paddingHorizontal: space(3),
  },
  hint: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
