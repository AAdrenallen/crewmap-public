import { useEffect, useState } from 'react';
import { pageX, useLayoutMode } from '../../ui/layout';
import {
  Alert,
  AppState,
  Pressable,
  Share,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FUEL_GRADES } from '@crewmap/hazards';
import { platform } from '@crewmap/platform';
import { t, type Lang } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { speakTest } from '../../core/nav';
import { useApp } from '../../core/store';
import { Field, KeyboardScroll, Segmented } from '../../ui/kit';
import { palette, useTheme } from '../../ui/theme';
import { Group, ListRow, SwitchRow } from '../../ui/screens-common/Layout';
import { ScreenHeader } from '../../ui/kit';
import { ConfirmSheet } from '../../ui/ConfirmSheet';
import { CHECK_IN } from '@crewmap/shared/safety';
import { useDeveloperVisible, useVersionTap } from '../../ui/shell/devGate';
import { PARKING } from '@crewmap/shared/parking';
import { loadParking, setParkingPrefs, useParking } from '../../core/parking';

const LANGS: { key: Lang; label: string }[] = [
  { key: 'en', label: 'English' },
  { key: 'fr', label: 'Français' },
  { key: 'ru', label: 'Русский' },
];

export default function Settings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  const s = useApp((x) => x.settings);
  const set = (p: Parameters<typeof engine.saveSettings>[0]) => void engine.saveSettings(p);
  const parking = useParking((x) => x.prefs);
  useEffect(() => {
    void loadParking().catch(() => undefined);
  }, []);
  const devVisible = useDeveloperVisible();
  const versionTap = useVersionTap();
  const version = Constants.expoConfig?.version ?? '';
  const [restoreKey, setRestoreKey] = useState('');
  const [busy, setBusy] = useState(false);
  const canOverlay = platform.os === 'android';
  const [overlayOk, setOverlayOk] = useState(() => canOverlay && platform.navOverlay.canDraw());
  const [navStatusOk, setNavStatusOk] = useState(() => canOverlay && platform.externalNavStatus.hasAccess());
  const [musicApps] = useState(() => (canOverlay ? platform.media.installed() : []));
  const [musicApp, setMusicApp] = useState(() => (canOverlay ? platform.media.preferred() : null));
  const cycleMusic = () => {
    const order = [null, ...musicApps.map((a) => a.pkg)];
    const next = order[(order.indexOf(musicApp) + 1) % order.length] ?? null;
    platform.media.setPreferred(next);
    setMusicApp(next);
  };

  useEffect(() => {
    if (!canOverlay) return;
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return;
      setOverlayOk(platform.navOverlay.canDraw());
      setNavStatusOk(platform.externalNavStatus.hasAccess());
    });
    return () => sub.remove();
  }, [canOverlay]);

  const voiceLang = s.voiceLang ?? s.lang;
  const [voiceMissing, setVoiceMissing] = useState(false);
  const [voiceNames, setVoiceNames] = useState<Partial<Record<Lang, string | null>>>({});
  useEffect(() => {
    let live = true;
    void platform.audio.voiceStatus(voiceLang).then((st) => live && setVoiceMissing(st === 'missing'));
    void Promise.all(LANGS.map(async (l) => [l.key, await platform.audio.voiceName(l.key)] as const)).then(
      (r) => live && setVoiceNames(Object.fromEntries(r)),
    );
    return () => {
      live = false;
    };
  }, [voiceLang]);
  const setVoiceLang = async (v: Lang) => {
    set({ voiceLang: v === s.lang ? null : v });
    // Offer the system voice download once per language when it is not installed.
    if ((await platform.audio.voiceStatus(v)) === 'missing') {
      const asked = await engine.kvFlag(`voiceAsked:${v}`);
      if (!asked) void platform.audio.installVoice();
    }
  };

  const [keyShown, setKeyShown] = useState<string | null>(null);
  const [delAsk, setDelAsk] = useState(false);
  const fail = (title: string, e: unknown) => Alert.alert(title, e instanceof Error ? e.message : String(e));

  const backup = async () => {
    setBusy(true);
    try {
      const { file, recoveryKey } = await engine.exportBackup();
      setKeyShown(recoveryKey);
      await Share.share({ url: file.uri, message: file.uri });
    } catch (e) {
      fail(t('set.backup'), e);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    setBusy(true);
    try {
      await engine.importBackup(new File(res.assets[0].uri), restoreKey);
      setRestoreKey('');
    } catch (e) {
      fail(t('set.restore'), e);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = () => setDelAsk(true);

  return (
    <>
      <KeyboardScroll
        style={{ backgroundColor: th.bg }}
        contentContainerStyle={{
          ...pageX(lay),
          paddingTop: insets.top + 8,
          gap: 18,
          paddingBottom: insets.bottom + 32,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader title={t('set.title')} />

        <Group index={0}>
          <ListRow
            icon="user"
            tint={palette.brand}
            testID="set-avatar"
            label={t('onb.avatar')}
            onPress={() => router.push('/avatar')}
          />
          <ListRow
            testID="set-ride"
            icon="car"
            tint={palette.brand}
            label={t('avatar.car')}
            onPress={() => router.push({ pathname: '/avatar', params: { tab: 'car' } })}
            last
          />
        </Group>

        <Group title={t('set.sharing')} index={1}>
          <SwitchRow
            testID="set-ghost"
            icon="ghost"
            tint="#6E56CF"
            label={t('set.ghost')}
            value={s.ghost}
            onChange={(v) => set({ ghost: v })}
          />
          <View style={styles.inset}>
            <Text style={[styles.inLabel, { color: th.textSoft }]}>{t('set.retention')}</Text>
            <Segmented
              value={String(s.retentionDays)}
              onChange={(v) => set({ retentionDays: Number(v) })}
              options={['7', '30', '90', '365'].map((d) => ({ key: d, label: t('set.days', { n: d }) }))}
            />
          </View>
        </Group>

        <Group title={t('set.driving')} index={3}>
          <View style={styles.inset}>
            <Text style={[styles.inLabel, { color: th.textSoft }]}>{t('set.mapTheme')}</Text>
            <Segmented
              testIDPrefix="map-theme-"
              value={s.mapTheme ?? 'adaptive'}
              onChange={(v) => set({ mapTheme: v as typeof s.mapTheme })}
              options={[
                { key: 'adaptive', label: t('set.mapAdaptive') },
                { key: 'light', label: t('set.mapLight') },
                { key: 'dark', label: t('set.mapDark') },
              ]}
            />
          </View>
          <View style={styles.inset}>
            <Text style={[styles.inLabel, { color: th.textSoft }]}>{t('set.voice')}</Text>
            <Segmented
              value={s.voice}
              onChange={(v) => set({ voice: v as typeof s.voice })}
              options={[
                { key: 'on', label: t('nav.voiceOn') },
                { key: 'alerts', label: t('nav.voiceAlerts') },
                { key: 'off', label: t('nav.voiceOff') },
              ]}
            />
          </View>
          {/* Safety check-in (D66): who is told is per crew / per friend; here only how long a remote stop lasts first. */}
          <View style={styles.inset}>
            <Text style={[styles.inLabel, { color: th.textSoft }]}>{`${t('checkIn.title')} · ${t('checkIn.wait')}`}</Text>
            <Segmented
              testIDPrefix="checkin-wait-"
              value={String(s.checkInWaitMin)}
              onChange={(v) => set({ checkInWaitMin: Number(v) })}
              options={CHECK_IN.waitChoicesMin.map((m) => ({ key: String(m), label: t('checkIn.min', { n: m }) }))}
            />
          </View>
          <SwitchRow
            icon="volume"
            tint={palette.pop}
            label={t('set.drivingSound')}
            value={s.drivingEmoteSound}
            onChange={(v) => set({ drivingEmoteSound: v })}
          />
          <SwitchRow
            icon="popup"
            tint={palette.pop}
            label={t('set.drivingPopups')}
            value={s.drivingEmotePopups}
            onChange={(v) => set({ drivingEmotePopups: v })}
          />
          <SwitchRow
            testID="set-read-chat"
            icon="volume"
            tint={palette.pop}
            label={t('set.readChatAloud')}
            value={s.readChatAloud}
            onChange={(v) => set({ readChatAloud: v })}
          />
          <SwitchRow testID="set-hide-previews" icon="lock" tint={palette.pop} label={t('set.hidePreviews')} value={s.hideChatPreviews} onChange={(v) => set({ hideChatPreviews: v })} />
          <SwitchRow testID="set-anon-publish" icon="warning" tint={palette.warn} label={t('set.anonPublish')} value={s.anonPublish} onChange={(v) => set({ anonPublish: v })} />
          <SwitchRow testID="set-anon-receive" icon="warning" tint={palette.warn} label={t('set.anonReceive')} value={s.anonReceive} onChange={(v) => set({ anonReceive: v })} />
          <SwitchRow testID="set-map-pois" icon="flame" tint={palette.pop} label={t('set.mapPois')} value={s.mapPois} onChange={(v) => set({ mapPois: v })} />
          {s.mapPois && (
            <View style={styles.inset}>
              <Text style={[styles.inLabel, { color: th.textSoft }]}>{t('poi.fuel')}</Text>
              <Segmented
                testIDPrefix="fuel-grade-"
                value={s.fuelGrade}
                onChange={(v) => set({ fuelGrade: v as typeof s.fuelGrade })}
                options={FUEL_GRADES.map((g) => ({ key: g, label: t(`fuel.${g}`) }))}
              />
            </View>
          )}
          <SwitchRow testID="set-auto-faster" icon="volume" tint={palette.pop} label={t('set.autoFaster')} value={s.autoSwitchFaster} onChange={(v) => set({ autoSwitchFaster: v })} />
          <SwitchRow testID="set-parking" icon="car" tint={palette.brand} label={t('set.parking')} value={parking.enabled} onChange={(v) => void setParkingPrefs({ enabled: v })} />
          {parking.enabled && (
            <View style={styles.inset}>
              <Text style={[styles.inLabel, { color: th.textSoft }]}>{t('set.parkingForget')}</Text>
              <Segmented
                value={String(parking.forgetAfterH)}
                onChange={(v) => void setParkingPrefs({ forgetAfterH: Number(v) })}
                options={PARKING.forgetAfterOptionsH.map((h) => ({ key: String(h), label: h === 0 ? t('park.untilDrive') : t('park.hours', { n: h }) }))}
              />
            </View>
          )}
          <SwitchRow
            icon="warning"
            tint={palette.warn}
            label={t('set.hazards')}
            value={s.hazardAlerts}
            onChange={(v) => set({ hazardAlerts: v })}
            last={!canOverlay}
          />
          {canOverlay && (
            <ListRow
              testID="set-overlay"
              icon="eye"
              tint={palette.brand}
              label={t('set.overlay')}
              value={overlayOk ? t('set.overlayOn') : t('set.overlayOff')}
              onPress={() => void platform.navOverlay.requestPermission()}
            />
          )}
          {canOverlay && (
            <ListRow
              testID="set-nav-status"
              icon="car"
              tint={palette.brand}
              label={t('set.navStatus')}
              value={navStatusOk ? t('set.navStatusOn') : t('set.navStatusOff')}
              onPress={() => void platform.externalNavStatus.requestAccess()}
              last={musicApps.length === 0}
            />
          )}
          {canOverlay && musicApps.length > 0 && (
            <ListRow
              testID="set-music-app"
              icon="volume"
              tint={palette.brand}
              label={t('set.musicApp')}
              value={musicApps.find((a) => a.pkg === musicApp)?.label ?? t('set.musicAuto')}
              onPress={cycleMusic}
              last
            />
          )}
        </Group>

        <Group title={t('set.notifications')} index={4}>
          <SwitchRow
            icon="users"
            tint={palette.ok}
            label={t('set.moments')}
            value={s.moments}
            onChange={(v) => set({ moments: v })}
            last={!s.moments}
          />
          {s.moments && (
            <View style={styles.inset}>
              <Text style={[styles.inLabel, { color: th.textSoft }]}>{t('set.nearDistance')}</Text>
              <Segmented
                value={String(s.friendsNearM)}
                onChange={(v) => set({ friendsNearM: Number(v) })}
                options={['200', '500', '1000', '2000'].map((m) => ({
                  key: m,
                  label: Number(m) >= 1000 ? `${Number(m) / 1000} km` : `${m} m`,
                }))}
              />
            </View>
          )}
        </Group>

        <Group title={t('set.language')} index={5}>
          <View style={styles.inset}>
            <Segmented value={s.lang} onChange={(v) => set({ lang: v as Lang })} options={LANGS} />
            <Text style={[styles.inLabel, { color: th.textSoft }]}>{t('set.voiceLang')}</Text>
            <Segmented value={s.voiceLang ?? s.lang} onChange={(v) => void setVoiceLang(v)} options={LANGS} />
            {voiceMissing && (
              <ListRow
                icon="download"
                tint={palette.brand}
                label={t('set.voiceInstall')}
                onPress={() => void platform.audio.installVoice()}
              />
            )}
          </View>
          {LANGS.map((l) => (
            <ListRow
              key={l.key}
              icon="volume"
              tint={palette.brand}
              label={l.label}
              value={voiceNames[l.key] ?? '—'}
            />
          ))}
          <SwitchRow
            icon="globe"
            label={t('set.namesOwnVoice')}
            value={s.namesOwnVoice}
            onChange={(v) => set({ namesOwnVoice: v })}
          />
          <ListRow
            icon="volume"
            tint={palette.brand}
            label={t('set.testVoice')}
            onPress={() => void speakTest()}
            testID="voice-test"
            last
          />
        </Group>

        <Group title={t('set.privacy')} index={6}>
          <ListRow
            icon="cloud"
            tint={palette.brand}
            label={t('set.backup')}
            onPress={busy ? undefined : () => void backup()}
          />
          <View style={styles.inset}>
            <Field
              label={t('set.recoveryKey')}
              value={restoreKey}
              onChangeText={setRestoreKey}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <ListRow
            icon="download"
            tint={palette.brand}
            label={t('set.restore')}
            onPress={restoreKey.length < 40 || busy ? undefined : () => void restore()}
            last
          />
        </Group>

        <Group title={t('set.help')} index={7}>
          <ListRow testID="set-tips" icon="sparkle" tint={palette.brand} label={t('tips.title')} onPress={() => router.push('/settings/tips' as never)} />
          <ListRow
            testID="set-licenses"
            icon="globe"
            tint={palette.grey}
            label={t('set.licenses')}
            onPress={() => router.push('/settings/licenses')}
          />
          <ListRow
            testID="set-diagnostics"
            icon="code"
            tint={palette.grey}
            label={t('diag.title')}
            onPress={() => router.push('/settings/diagnostics' as never)}
            last={!devVisible}
          />
          {devVisible && (
            <ListRow
              testID="set-developer"
              icon="code"
              tint={palette.grey}
              label={t('set.developer')}
              onPress={() => router.push('/settings/developer')}
              last
            />
          )}
        </Group>

        <Group title={t('set.dangerZone')} index={8}>
          <ListRow
            testID="set-delete"
            icon="trash"
            danger
            label={t('set.delete')}
            onPress={confirmDelete}
            last
          />
        </Group>

        <Pressable
          testID="set-version"
          accessibilityRole="text"
          onPress={() => {
            if (versionTap() && platform.os === 'android')
              ToastAndroid.show(t('set.developer'), ToastAndroid.SHORT);
          }}
          style={styles.verBox}
        >
          <Text
            style={[styles.ver, { color: th.textSoft }]}
          >{`${t('set.version')} ${version} · Mapbox · © OpenStreetMap`}</Text>
        </Pressable>
      </KeyboardScroll>
      <ConfirmSheet
        visible={keyShown !== null}
        title={t('set.recoveryKey')}
        message={keyShown ?? ''}
        confirmLabel={t('circle.share')}
        destructive={false}
        onConfirm={() => {
          void Share.share({ message: keyShown ?? '' });
          setKeyShown(null);
        }}
        onCancel={() => setKeyShown(null)}
      />
      <ConfirmSheet
        visible={delAsk}
        title={t('set.delete')}
        confirmLabel={t('set.deleteConfirm')}
        onConfirm={() => {
          setDelAsk(false);
          void engine.deleteAccount().then(() => router.replace('/onboarding'));
        }}
        onCancel={() => setDelAsk(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  inset: { paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  inLabel: { fontSize: 13, fontWeight: '600' },
  verBox: { minHeight: 48, justifyContent: 'center' },
  ver: { textAlign: 'center', fontSize: 12, marginTop: 4 },
});
