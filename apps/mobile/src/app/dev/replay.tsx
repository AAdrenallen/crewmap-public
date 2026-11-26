import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { T } from '../../ui/kit';
import { useDevRouteGuard } from '../../ui/shell/devGate';
import { useTheme } from '../../ui/theme';

/**
 * Dev-only deep link for Maestro / emulator runs: crewmap://dev/replay?name=highway&speedup=20.
 * Renders nothing and does nothing in release builds.
 */
export default function DevReplay() {
  const { name, speedup } = useLocalSearchParams<{ name?: string; speedup?: string }>();
  const router = useRouter();
  const th = useTheme();
  const allowed = useDevRouteGuard();
  const [state, setState] = useState('');
  useEffect(() => {
    if (!__DEV__ || !name) return;
    setState(`replay ${name}`);
    router.replace('/');
    void import('../../core/devReplay').then(({ runReplay }) =>
      runReplay(name as Parameters<typeof runReplay>[0], Number(speedup ?? 20)).then(() => setState(`done ${name}`)),
    );
  }, [name, speedup, router]);
  if (!allowed) return null;
  return (
    <View style={{ flex: 1, backgroundColor: th.bg, padding: 24 }}>
      <T testID="dev-replay-state">{state}</T>
    </View>
  );
}
