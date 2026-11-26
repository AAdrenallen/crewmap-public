import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { T } from '../../ui/kit';
import { useDevRouteGuard } from '../../ui/shell/devGate';
import { useTheme } from '../../ui/theme';

/**
 * Dev-only deep link for Maestro: crewmap://dev/demo?action=start|emote|stop|remove (demo friend, see src/dev/demo.ts).
 * Renders nothing and does nothing in release builds.
 */
export default function DevDemo() {
  const { action } = useLocalSearchParams<{ action?: string }>();
  const router = useRouter();
  const th = useTheme();
  const allowed = useDevRouteGuard();
  const [state, setState] = useState('');
  useEffect(() => {
    if (!__DEV__ || !action) return;
    setState(`demo ${action}`);
    router.replace('/');
    void import('../../dev/demo').then((d) => {
      if (action === 'start') return d.startDemo();
      if (action === 'emote') return d.demoSendEmote();
      if (action === 'crowd') return void d.spawnDemoCrewmates(8);
      if (action === 'stop') return d.stopDemo();
      if (action === 'remove') return d.removeDemo();
      return undefined;
    });
  }, [action, router]);
  if (!allowed) return null;
  return (
    <View style={{ flex: 1, backgroundColor: th.bg, padding: 24 }}>
      <T testID="dev-demo-state">{state}</T>
    </View>
  );
}
