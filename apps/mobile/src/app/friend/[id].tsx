import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { destinationCards, incomingPrompts, minutesLeft } from '@crewmap/shared/companions';
import { agoParts } from '@crewmap/shared/friend';
import { t } from '@crewmap/shared/i18n';
import type { ArrivalSubscription } from '@crewmap/shared/places';
import { formatClock, formatMinutes } from '@crewmap/shared/units';
import { peerSupports } from '@crewmap/p2p';
import { engine } from '../../core/engine';
import { useDriveAlong } from '../../core/companions';
import { locateFriend } from '../../core/locate';
import { useAsks } from '../../core/asksStore';
import { loadMuted, setAskMuted, setMuted, useFriendPrefs } from '../../core/friendPrefs';
import { useApp } from '../../core/store';
import {
  BatteryIcon,
  Bouncy,
  Card,
  CountBadge,
  EmptyState,
  H,
  Icon,
  PresenceDot,
  presenceState,
  SectionLabel,
  Toast,
  Toggle,
  type IconName,
} from '../../ui/kit';
import { FriendInfo } from '../../ui/friend/FriendInfo';
import { useNow } from '../../ui/friend/useNow';
import { AvatarStill } from '../../ui/map/Sprites';
import { driveLabel } from '../../ui/friend/friendMetrics';
import { AskCard } from '../../ui/drive/AskCards';
import { ShareUserRow } from '../../ui/share/ShareUserRow';
import { useFriendContext } from '../../ui/drive/DriveHud';
import { DRIVE_UX } from '../../ui/drive/driveUx';
import { font, palette, radius, type, useTheme } from '../../ui/theme';

function Action({
  icon,
  label,
  color,
  onPress,
  testID,
  badge,
  disabled,
}: {
  icon: IconName;
  label: string;
  color: string;
  onPress: () => void;
  testID: string;
  badge?: number;
  disabled?: boolean;
}) {
  const th = useTheme();
  return (
    <Bouncy
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      style={[styles.action, disabled && { opacity: 0.4 }]}
      onPress={onPress}
    >
      <View style={[styles.actionIcon, { backgroundColor: color }]}>
        <Icon name={icon} size={24} color="#FFFFFF" />
        {!!badge && <CountBadge n={badge} style={{ position: 'absolute', top: -2, right: -2 }} />}
      </View>
      <Text style={[type.small, { color: th.text }]} numberOfLines={1}>
        {label}
      </Text>
    </Bouncy>
  );
}

export default function FriendSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const th = useTheme();
  const now = useNow();
  const f = useApp((s) => s.allFriends[id]);
  const me = useApp((s) => s.me);
  const places = useApp((s) => s.places);
  const nav = useApp((s) => s.nav);
  const digest = useApp((s) => s.emoteDigest[id]);
  const unread = useApp((s) => s.chatUnread[id] ?? 0);
  const muted = useFriendPrefs((s) => !!s.muted[id]);
  const inDriveAlong = useDriveAlong(
    (s) => s.session?.members[id]?.state === 'joined' || s.session?.members[id]?.state === 'invited',
  );
  const liveEtaOn = useDriveAlong((s) => s.etaOut.includes(id));
  const etaIn = useDriveAlong((s) => s.etaIn[id]);
  const prefsLoaded = useFriendPrefs((s) => s.loaded);
  const askMuted = useFriendPrefs((s) => !!s.askMuted[id]);
  const asks = useAsks((s) => s.entries);
  const [rev, setRev] = useState(0);
  const [toast, setToast] = useState<{ message: string; tone: 'neutral' | 'danger' } | null>(null);
  const fix = useApp((s) => s.fix);
  // While moving: a compact card (drive-along, directions, emote) that closes itself when left alone.
  const compact = useFriendContext() === 'driveMoving';
  const [touch, setTouch] = useState(0);
  // Opened card: that friend's drive time refreshes now and stays focused while open (D45).
  useEffect(() => {
    engine.net.etaFocus = id;
    // After the sheet finishes opening, so the refresh never stalls the transition.
    const task = setTimeout(() => void engine.tracking?.refreshEtas(), 320);
    return () => {
      clearTimeout(task);
      if (engine.net.etaFocus === id) engine.net.etaFocus = null;
    };
  }, [id]);
  useEffect(() => {
    if (!compact) return;
    const timer = setTimeout(() => router.back(), DRIVE_UX.detailsAutoCloseMs);
    return () => clearTimeout(timer);
  }, [compact, touch, router]);

  useEffect(() => {
    if (!prefsLoaded) void loadMuted().catch(() => undefined);
  }, [prefsLoaded]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.back();
      return true;
    });
    return () => sub.remove();
  }, [router]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  // The subscriptions live in the Yjs doc (not in the store): `rev` re-reads them after each local change.
  const subs = useMemo(
    () =>
      me
        ? [...engine.net.doc.subscriptions.values()].filter(
            (s) => s.subscriber === me.deviceId && s.target === id,
          )
        : [],
    [me, id, rev],
  );

  const shareEta = useCallback(async () => {
    const pr = nav?.active ? nav.progress : null;
    if (!pr) return;
    const ok = await engine.chat.send(
      id,
      t('friend.etaMsg', { time: formatClock(pr.eta), min: formatMinutes(pr.remainingS) }),
    );
    setToast({ message: t(ok ? 'friend.etaSent' : 'friend.etaFailed'), tone: ok ? 'neutral' : 'danger' });
  }, [nav, id]);

  if (!f || !me) {
    return (
      <View style={{ flex: 1, backgroundColor: th.bg }}>
        <EmptyState
          testID="friend-gone"
          icon="person"
          title={t('friend.gone')}
          action={{ label: t('common.close'), onPress: () => router.back() }}
        />
      </View>
    );
  }
  const p = f.presence;
  const canLocate = !!p && !f.paused;
  const theirPlaces = places.filter((pl) => pl.owner === id && pl.visibility === 'shared');
  const subFor = (placeId: string) => subs.find((s) => s.placeId === placeId);
  const setSub = (placeId: string, patch: Partial<ArrivalSubscription>) => {
    const cur = subFor(placeId) ?? {
      id: `${me.deviceId.slice(0, 8)}-${id.slice(0, 8)}-${placeId}`,
      subscriber: me.deviceId,
      target: id,
      placeId,
      arrive: false,
      leave: false,
    };
    engine.net.doc.subscriptions.set(cur.id, { ...cur, ...patch });
    setRev((r) => r + 1);
  };
  const homeSub = subs.find((s) => s.drivingHome);
  const navigating = !!nav?.active && !!nav.progress;
  // Ask location = "where do you want me?"; a crewmate whose policy shows me nothing still offers "ask to share once" (D47).
  const askWhere = engine.asks.availability(id, 'where');
  const askOnce = engine.asks.availability(id, 'once');
  const locHidden = !canLocate || p?.prec !== 'p';
  const askLabel = (a: typeof askWhere, ok: string) => (a === 'old' ? t('ask.needsUpdate') : a === 'ok' ? ok : t('fa.asked'));
  const askToast = (a: typeof askWhere) =>
    setToast({ message: a === 'ok' ? t('fa.asked') : a === 'old' ? t('ask.needsUpdate') : a === 'offline' ? t('friend.etaFailed') : t('ask.tooSoon'), tone: a === 'ok' ? 'neutral' : 'danger' });
  const myAsks = [...incomingPrompts(asks), ...destinationCards(asks)].filter((e) => e.peer === id);
  const canLiveEta = navigating && engine.companions.availability(id, 'etaShare', 'eta-share') === 'ok';
  const canChat = peerSupports(p, 'chat') !== false;
  const hasStats = !!f.profile.stats;
  const ago = p ? agoParts(p.t, now) : null;
  const goTo = () => {
    if (p)
      router.push({
        pathname: '/route',
        params: { name: f.profile.name, lat: String(p.lat), lng: String(p.lng) },
      });
  };

  return (
    <View
      style={{ flex: 1, backgroundColor: th.bg }}
      onTouchStart={compact ? () => setTouch((n) => n + 1) : undefined}
    >
      <ScrollView nestedScrollEnabled contentContainerStyle={{ padding: 20, paddingTop: 28, gap: 16 }}>
        <View style={styles.head}>
          <View>
            <View style={[styles.avatar, { backgroundColor: th.cardAlt }]}>
              <AvatarStill avatar={f.profile.avatar} size={80} />
            </View>
            <View style={styles.dot}>
              <PresenceDot state={presenceState(f)} ring={th.bg} size={18} />
            </View>
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <H>{f.profile.name}</H>
            {f.paused ? (
              <Text style={[type.body, { color: th.textSoft }]}>{t('map.paused')}</Text>
            ) : p ? (
              <>
                {!!driveLabel(f, fix) && (
                  <Text style={[type.headline, font('bold'), { color: th.accent }]} testID="friend-eta">
                    {driveLabel(f, fix)}
                  </Text>
                )}
                {p.eta !== undefined && p.etaSrc && (
                  <Text style={[type.small, font('medium'), { color: th.textSoft }]} testID="friend-eta-via">
                    {t('friend.etaVia', { time: formatClock(p.eta), app: t(`friend.etaVia.${p.etaSrc}`) })}
                  </Text>
                )}
                <View style={styles.meta}>
                  {p.bat !== null && (
                    <>
                      <BatteryIcon pct={p.bat} charging={p.chg} size={12} color={th.textSoft} />
                      <Text style={[type.caption, { color: th.textSoft }]}>
                        {t('map.battery', { pct: p.bat })}
                      </Text>
                      <Text style={[type.caption, { color: th.textFaint }]}>·</Text>
                    </>
                  )}
                  {ago && (
                    <Text style={[type.caption, { color: th.textSoft }]}>
                      {t(`friend.ago.${ago.unit}`, { n: ago.n })}
                    </Text>
                  )}
                </View>
                {!!f.once && (
                  <Text style={[type.small, font('bold'), { color: palette.sun }]} testID="friend-once-badge">
                    {t('ask.sharedOnce', { min: minutesLeft(f.once.until, now) })}
                  </Text>
                )}
                {digest && (
                  <Text style={[type.caption, { color: th.textSoft }]} testID="friend-emote-digest">
                    {t('emote.digest', { name: f.profile.name, count: digest.count })}
                  </Text>
                )}
              </>
            ) : (
              <Text style={[type.body, { color: th.textSoft }]} testID="friend-not-shared">
                {t('ask.notShared')}
              </Text>
            )}
          </View>
        </View>

        {myAsks.map((e) => (
          <AskCard key={e.id} entry={e} pill={false} />
        ))}

        <View style={styles.actions}>
          {/* Locate: back to the map, fly there, then the action pill (directions, drive together, ask...). */}
          <Action
            testID="friend-locate"
            icon="locate"
            label={t('friend.locate')}
            color={th.accent}
            onPress={() => {
              locateFriend(id);
              router.dismissTo('/');
            }}
          />
          {!compact && (
            <Action
              testID="open-chat"
              icon="send"
              label={t('friend.message')}
              color={palette.brand}
              badge={unread}
              disabled={!canChat}
              onPress={() => router.push({ pathname: '/chat/[id]', params: { id } })}
            />
          )}
          <Action
            testID="friend-emote"
            icon="chat"
            label={t('friend.emote')}
            color={palette.pop}
            onPress={() => router.push({ pathname: '/emote/[id]', params: { id } })}
          />
          <Action
            testID="friend-drive-along"
            icon="users"
            label={t('gd.title')}
            color={palette.mint}
            onPress={() => {
              router.push(inDriveAlong ? '/drive-along' : { pathname: '/search', params: { with: id } });
            }}
          />
          {!compact && (
            <Action
              testID="friend-ask-location"
              icon="locate"
              label={askLabel(askWhere, t('fa.askLocation'))}
              color={palette.brandDeep}
              disabled={askWhere !== 'ok'}
              onPress={() => void engine.asks.ask(id, 'where').then(askToast)}
            />
          )}
          {!compact && locHidden && !f.once && (
            <Action
              testID="friend-ask-once"
              icon="clock"
              label={askLabel(askOnce, t('ask.askOnce'))}
              color={palette.sun}
              disabled={askOnce !== 'ok'}
              onPress={() => void engine.asks.ask(id, 'once').then(askToast)}
            />
          )}
          {!compact && (
            <Action
              testID="friend-ask-mute"
              icon="alert"
              label={askMuted ? t('ask.unmute') : t('ask.mute')}
              color={th.textSoft}
              onPress={() => void setAskMuted(id, !askMuted)}
            />
          )}
          {(canLocate || navigating) && (
            <Action
              testID="friend-share-eta"
              icon="clock"
              label={t('friend.shareEta')}
              color={palette.sun}
              onPress={() => {
                if (navigating) void shareEta();
                else goTo();
              }}
            />
          )}
        </View>

        {!!etaIn && (
          <Text testID="friend-live-eta" style={[type.small, font('bold'), { color: th.accent }]}>
            {t('fa.etaIn', { time: formatClock(etaIn.eta), dest: etaIn.dest })}
          </Text>
        )}
        {(canLiveEta || liveEtaOn) && (
          <Card style={{ paddingVertical: 0 }}>
            <Toggle
              testID="friend-live-eta-toggle"
              label={t('fa.liveEta')}
              value={liveEtaOn}
              onChange={(v) => void engine.companions.shareEta(id, v)}
            />
          </Card>
        )}

        {!compact && (
          <>
            <FriendInfo id={id} f={f} />

            <Card style={{ paddingVertical: 0 }}>
              <Bouncy
                testID="friend-stats"
                accessibilityRole="button"
                accessibilityState={{ disabled: !hasStats }}
                accessibilityLabel={t('friend.stats')}
                disabled={!hasStats}
                haptic={hasStats ? 'tap' : null}
                style={[styles.statsRow, { opacity: hasStats ? 1 : 0.5 }]}
                onPress={() => router.push({ pathname: '/stats', params: { who: id } })}
              >
                <Icon name="trophy" size={22} color={hasStats ? palette.pop : th.textSoft} />
                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { color: th.text }]}>{t('friend.stats')}</Text>
                  {!hasStats && (
                    <Text style={[type.caption, { color: th.textSoft }]}>{t('friend.noStats')}</Text>
                  )}
                </View>
                {hasStats && <Icon name="chevron" size={18} color={th.textFaint} />}
              </Bouncy>
            </Card>

            <SectionLabel>{t('friend.notify')}</SectionLabel>
            <Card style={{ paddingVertical: 0 }}>
              <Toggle
                testID="friend-mute"
                label={t('friend.mute')}
                value={muted}
                onChange={(v) => void setMuted(id, v).catch(() => undefined)}
              />
              {theirPlaces.map((pl) => (
                <View key={pl.id}>
                  <Toggle
                    label={t('friend.arrives', { place: pl.name })}
                    value={subFor(pl.id)?.arrive ?? false}
                    onChange={(v) => setSub(pl.id, { arrive: v })}
                  />
                  <Toggle
                    label={t('friend.leaves', { place: pl.name })}
                    value={subFor(pl.id)?.leave ?? false}
                    onChange={(v) => setSub(pl.id, { leave: v })}
                  />
                  {(subFor(pl.id)?.arrive || subFor(pl.id)?.leave) && (
                    <Toggle
                      label={t('fa.once')}
                      value={subFor(pl.id)?.once ?? false}
                      onChange={(v) => setSub(pl.id, { once: v })}
                    />
                  )}
                </View>
              ))}
              <Toggle
                label={t('friend.drivingHome')}
                value={!!homeSub}
                onChange={(v) => {
                  const home = theirPlaces.find((pl) => pl.icon === 'home');
                  const sid = `${me.deviceId.slice(0, 8)}-${id.slice(0, 8)}-home`;
                  if (v)
                    engine.net.doc.subscriptions.set(sid, {
                      id: sid,
                      subscriber: me.deviceId,
                      target: id,
                      placeId: home?.id ?? 'home',
                      arrive: false,
                      leave: false,
                      drivingHome: true,
                    });
                  else engine.net.doc.subscriptions.delete(homeSub?.id ?? sid);
                  setRev((r) => r + 1);
                }}
              />
            </Card>

            <Card style={{ padding: 0 }}>
              <ShareUserRow friendId={id} name={f.profile.name} />
            </Card>
          </>
        )}
      </ScrollView>
      {toast && (
        <Toast
          testID="friend-toast"
          message={toast.message}
          tone={toast.tone}
          icon={toast.tone === 'danger' ? 'alert' : 'check'}
          style={styles.toast}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { position: 'absolute', right: 2, bottom: 2 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12, columnGap: 10 },
  action: {
    flexBasis: '30%',
    flexGrow: 1,
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderRadius: radius.m,
    minHeight: 48,
  },
  actionIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingVertical: 8 },
  toast: { position: 'absolute', left: 16, right: 16, bottom: 24 },
});
