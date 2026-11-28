import { useEffect, useState } from 'react';
import { pageX, useLayoutMode } from '../../ui/layout';
import { Share, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BenchmarkReport, FunctionName } from '@crewmap/p2p';
import { t } from '@crewmap/shared/i18n';
import { formatAge } from '@crewmap/shared/units';
import { benchmark } from '../../core/benchmark';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { Button, Card, Chip, Field, KeyboardScroll, H, ScreenHeader, Segmented, T, Toggle } from '../../ui/kit';
import { useTheme } from '../../ui/theme';
import { useActiveInterval } from '../../ui/useActiveInterval';
import { useDeveloperVisible } from '../../ui/shell/devGate';

type DemoModule = typeof import('../../dev/demo');

/** Demo friend controls (dev builds only; the module is loaded lazily behind __DEV__). */
function DemoCard() {
  const [mod, setMod] = useState<DemoModule | null>(null);
  const [st, setSt] = useState('off');
  useEffect(() => {
    if (!__DEV__) return;
    let off: (() => void) | undefined;
    void import('../../dev/demo').then((m) => {
      setMod(m);
      setSt(m.demoStatus());
      off = m.onDemoStatus(setSt);
    });
    return () => off?.();
  }, []);
  if (!__DEV__ || !mod) return null;
  return (
    <Card style={{ gap: 8 }}>
      <T style={{ fontWeight: '900' }}>{t('dev.demo')}</T>
      <T soft testID="dev-demo-status">{st === 'running' ? t('dev.demoRunning') : st === 'joining' ? '…' : t('dev.demoStopped')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip testID="dev-demo-start" label={t('dev.demoStart')} onPress={() => void mod.startDemo()} />
        <Chip testID="dev-demo-stop" label={t('dev.demoStop')} onPress={() => mod.stopDemo()} />
        <Chip testID="dev-demo-remove" label={t('dev.demoRemove')} onPress={() => void mod.removeDemo()} />
      </View>
      <Button kind="ghost" testID="dev-demo-emote" label={t('dev.demoEmote')} disabled={st !== 'running'} onPress={() => void mod.demoSendEmote()} />
      <Button kind="ghost" testID="dev-demo-crowd" label={t('dev.demoCrowd')} disabled={st !== 'running'} onPress={() => void mod.spawnDemoCrewmates(8).then(() => undefined)} />
    </Card>
  );
}

const FNS: FunctionName[] = ['presence', 'emotes', 'arrivals', 'sync', 'chores', 'wake'];

export default function Developer() {
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  const visible = useDeveloperVisible();
  const s = useApp((x) => x.settings);
  const health = useApp((x) => x.hazardHealth);
  const circle = useApp((x) => x.circle);
  const me = useApp((x) => x.me);
  const [relay, setRelay] = useState(s.pcRelayUrl);
  const [hours, setHours] = useState('8');
  const [, force] = useState(0);
  const [report, setReport] = useState<{ report: BenchmarkReport; markdown: string } | null>(null);
  const stats = engine.net.router?.stats;
  const isOwner = circle?.ownerId === me?.deviceId;
  const cfg = engine.hazards?.config;

  useEffect(() => {
    void benchmark.lastReport().then(setReport);
    return benchmark.onChange(() => force((n) => n + 1));
  }, []);
  useActiveInterval(() => force((n) => n + 1), 2000, visible);

  // Production builds: the screen only renders after the hidden unlock (7 taps on the version in Settings).
  if (!visible) {
    return (
      <View style={{ flex: 1, backgroundColor: th.bg, ...pageX(lay), paddingTop: insets.top + 8 }}>
        <ScreenHeader title={t('set.developer')} />
      </View>
    );
  }

  return (
    <KeyboardScroll style={{ backgroundColor: th.bg }} contentContainerStyle={{ ...pageX(lay), paddingTop: insets.top + 12, gap: 14, paddingBottom: insets.bottom + 30 }}>
      <H>{t('set.developer')}</H>

      {__DEV__ && <DemoCard />}

      <Card style={{ gap: 8 }}>
        <T style={{ fontWeight: '900' }}>{t('set.transport')}</T>
        {FNS.map((fn) => (
          <View key={fn} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T style={{ flex: 1 }}>{fn}</T>
            <Segmented
              value={s.transport[fn]}
              onChange={(v) => void engine.saveSettings({ transport: { ...s.transport, [fn]: v } })}
              options={[{ key: 'p2p', label: 'P2P' }, { key: 'relay', label: 'PC' }]}
            />
          </View>
        ))}
        <Field testID="dev-relay-url" label={t('set.pcRelay')} value={relay} onChangeText={setRelay} autoCapitalize="none" autoCorrect={false} placeholder="wss://" />
        <Button kind="ghost" label={t('common.save')} disabled={relay !== '' && !/^wss?:\/\//.test(relay)} onPress={() => void engine.saveSettings({ pcRelayUrl: relay.trim() })} />
        {stats && (
          <T soft style={{ fontSize: 12 }} testID="dev-router-stats">
            direct {stats.sentDirect} · nostr {stats.sentNostr} · relay {stats.sentRelay} · in {stats.received} · rejected {stats.rejected} · wakes {stats.wakes} · {Math.round(stats.bytesOut / 1024)} KB
          </T>
        )}
      </Card>

      <Card style={{ gap: 8 }}>
        <T style={{ fontWeight: '900' }}>{t('set.hazards')}</T>
        {health.map((h) => (
          <View key={h.source} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} testID={`health-${h.source}`}>
            <Text style={{ fontSize: 16 }}>{h.status === 'ok' ? '🟢' : h.status === 'degraded' ? '🟡' : h.status === 'disabled' ? '⚪' : '🔴'}</Text>
            <T style={{ flex: 1 }}>{h.source}</T>
            <T soft style={{ fontSize: 12 }}>
              {h.status}
              {h.lastHttpStatus ? ` · HTTP ${h.lastHttpStatus}` : ''}
              {h.lastOkAt ? ` · ok ${formatAge(h.lastOkAt, Date.now())}` : ''}
            </T>
          </View>
        ))}
        {engine.hazards?.service.log.slice(-6).reverse().map((e, i) => (
          <T key={i} soft style={{ fontSize: 11 }}>
            {new Date(e.t).toISOString().slice(11, 19)} {e.source}: {e.from} → {e.to} ({e.detail})
          </T>
        ))}
        {isOwner && cfg && (
          <>
            <Toggle label={t('dev.wazeLive')} value={cfg.wazeEnabled} onChange={(v) => engine.hazards.setConfig({ wazeEnabled: v, paidEnabled: cfg.paidEnabled })} />
            <Toggle label={t('dev.wazePaid')} value={cfg.paidEnabled} onChange={(v) => engine.hazards.setConfig({ wazeEnabled: cfg.wazeEnabled, paidEnabled: v })} />
          </>
        )}
      </Card>

      <Card style={{ gap: 10 }}>
        <T style={{ fontWeight: '900' }}>{t('set.benchmark')}</T>
        {benchmark.running ? (
          <T testID="bench-running">⏱️ {benchmark.phase}</T>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {['1', '3', '8'].map((h) => (
                <Chip key={h} label={`${h} h`} active={hours === h} onPress={() => setHours(h)} />
              ))}
            </View>
            <Button testID="bench-start" label={t('set.benchmark')} onPress={() => void benchmark.run(Number(hours)).then(() => benchmark.lastReport().then(setReport))} />
          </>
        )}
        {report && (
          <>
            <T soft style={{ fontSize: 11 }} testID="bench-report">
              {report.markdown}
            </T>
            <Button kind="ghost" label={t('circle.share')} onPress={() => void Share.share({ message: report.markdown })} />
          </>
        )}
      </Card>
    </KeyboardScroll>
  );
}
