import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler, StyleSheet, Text, View, type LayoutRectangle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter, useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Rect } from '@crewmap/shared/emotes';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../core/engine';
import { finite } from '../core/errorScrub';
import { useApp, type FriendView } from '../core/store';
import { CrewMapView, type CrewMapHandle } from '../ui/map/CrewMapView';
import { FriendCard } from '../ui/home/FriendCard';
import { CrewDeck } from '../ui/home/CrewDeck';
import { FriendActions } from '../ui/home/FriendActions';
import { LocatePill } from '../ui/home/LocatePill';
import { LOCATE_UX, locateTarget, pillBottom } from '../ui/home/locateLogic';
import { locateFriend, useLocate } from '../core/locate';
import { useOrderedRows } from '../ui/home/useOrderedRows';
import { moveFriend } from '../core/crewOrder';
import type { MoveKind } from '../ui/home/orderLogic';
import { DECK_VIEW_H } from '../ui/home/deckLogic';
import { CrewFilterMenu } from '../ui/home/CrewFilterMenu';
import { CrewmateSheet } from '../ui/home/CrewmateSheet';
import { needsSheet, snapHeights } from '../ui/home/sheetLogic';
import { NavBanners } from '../ui/drive/NavBanners';
import { ReportBar, SpeedBadge, StillThere } from '../ui/drive/DrivingHud';
import { RouteNoticeBanner } from '../ui/drive/RouteNoticeBanner';
import { EmoteOverlay } from '../ui/drive/EmoteOverlay';
import { MsgBlips } from '../ui/chat/MsgBlips';
import { CompanionOverlay } from '../ui/drive/Companions';
import { GroupDriveCards } from '../ui/drive/GroupDrive';
import { AskCards } from '../ui/drive/AskCards';
import {
  EtaPill,
  FasterOffer,
  QueueChip,
  TripEndCard,
  useDriveQueue,
  useMomentNotice,
  useMotion,
} from '../ui/drive/DriveHud';
import { MusicButton, MusicCard, MusicDrawer } from '../ui/drive/Music';
import { friendContext, hudPlan } from '../ui/drive/driveUx';
import { Bouncy, ControlGroup, Icon, IconButton, Toast } from '../ui/kit';
import { useLayoutMode } from '../ui/layout';
import { SyncChip } from '../ui/shell/SyncChip';
import { elevation, radius, type, useTheme } from '../ui/theme';

export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const wide = lay.wide;
  const th = useTheme();
  const map = useRef<CrewMapHandle>(null);
  const { focusLat, focusLng, pinFor, pinNote } = useLocalSearchParams<{ focusLat?: string; focusLng?: string; pinFor?: string; pinNote?: string }>();
  useEffect(() => {
    if (focusLat && focusLng && finite(Number(focusLat)) && finite(Number(focusLng)))
      setTimeout(() => map.current?.flyTo(Number(focusLat), Number(focusLng), 15), 400);
  }, [focusLat, focusLng]);
  const friends = useApp((s) => s.friends);
  const nav = useApp((s) => s.nav);
  const driving = useApp((s) => s.driving || s.nav?.active === true);
  const ghost = useApp((s) => s.settings.ghost);
  // Speed-aware HUD: moving hides secondary controls and enlarges the primary ones; a stop reveals more.
  const motion = useMotion();
  const plan = hudPlan(driving ? motion : 'stopped');
  const speedKmh = useApp((s) => Math.round((s.fix?.speed ?? 0) * 3.6));
  const queue = useDriveQueue(driving ? motion : 'stopped');
  const notice = useMomentNotice(friendContext(driving, motion));
  const crewUnread = useApp((s) =>
    Object.entries(s.chatUnread).reduce((n, [k, v]) => (k.startsWith('crew:') ? n + v : n), 0),
  );
  const [layout, setLayout] = useState<Record<string, LayoutRectangle>>({});
  const track = (k: string) => (r: LayoutRectangle) => setLayout((l) => ({ ...l, [k]: r }));
  const list = useMemo(
    () => Object.values(friends).sort((a, b) => (b.presence?.t ?? 0) - (a.presence?.t ?? 0)),
    [friends],
  );
  const ordered = useOrderedRows();
  const deckIds = useMemo(() => ordered.rows.map((r) => r.id), [ordered.rows]);
  const [actionsFor, setActionsFor] = useState<FriendView | null>(null);
  const moveDeck = useCallback(
    (id: string, kind: MoveKind) => void moveFriend(ordered.key, deckIds, id, kind).catch(() => undefined),
    [ordered.key, deckIds],
  );
  const openFriend = useCallback(
    (id: string) => {
      const f = useApp.getState().friends[id];
      if (f?.presence) map.current?.flyTo(f.presence.lat, f.presence.lng);
      router.push({ pathname: '/friend/[id]', params: { id } });
    },
    [router],
  );
  const renderDeckCard = useCallback(
    (id: string) => {
      const f = friends[id];
      return f ? <FriendCard f={f} fill onPress={() => openFriend(id)} onLongPress={() => setActionsFor(f)} /> : null;
    },
    [friends, openFriend],
  );
  // Locate (friend screen / long-press): fly to their exact or last-known position; the pill offers the actions.
  const locating = useLocate((s) => s.id);
  const locateAt = useLocate((s) => s.at);
  useEffect(() => {
    if (!locating) return;
    const f = useApp.getState().allFriends[locating];
    const target = f ? locateTarget(f, Date.now()) : null;
    if (target && target.kind !== 'hidden') {
      // After the friend sheet has closed, so the camera move is not cut short by the transition.
      const task = setTimeout(() => map.current?.flyTo(target.lat, target.lng, LOCATE_UX.zoom), 300);
      return () => clearTimeout(task);
    }
  }, [locating, locateAt]);
  // The map centres on the crewmate that settles in the focused slot.
  const focusFriend = useCallback((id: string) => {
    const p = useApp.getState().friends[id]?.presence;
    if (p) map.current?.flyTo(p.lat, p.lng);
  }, []);
  const showSheet = list.length > 0 && needsSheet(list.length, wide);
  // The sheet sits below the search / chips column (portrait: below the top stack; landscape: below the left column).
  const topReserved = layout.top ? layout.top.y + layout.top.height + 8 : insets.top + 150;
  // Mapbox wordmark + (i): tucked into the top-right corner (portrait: just under the top chrome; landscape: the
  // chrome is a left column, so right under the status bar). Mapbox only allows moving them, not hiding or resizing.
  const chromeBottom = layout.top ? layout.top.y + layout.top.height : insets.top + 64;
  const ornaments = useMemo(
    // Browsing: the row under the search bar is empty on the right (the crew filter sits left), so tuck it there.
    () => ({ top: wide ? insets.top + 4 : !driving ? insets.top + 66 : chromeBottom + 2, right: insets.right + 4 }),
    [wide, driving, insets.top, insets.right, chromeBottom],
  );
  // Side controls start below the wordmark row (~24 dp) so nothing covers it.
  const sideTop = wide ? insets.top + 34 : ornaments.top + 28;
  const collapsedH = snapHeights(lay.height - topReserved - insets.bottom).collapsed + insets.bottom;
  const sheetH = useSharedValue(collapsedH);
  const recenterSheet = useAnimatedStyle(() => ({ bottom: sheetH.value + 12 }));
  const aboveCarousel = showSheet ? collapsedH + 8 : insets.bottom + (list.length ? DECK_VIEW_H : 24);
  // Wide screens: banners, search and the ETA footer share one left column so the map stays visible on the right.
  const colW = lay.panelW + 28;

  // Layout map of occupied regions for the driver-safe emote overlay.
  const occupied: Rect[] = useMemo(
    () => [
      ...Object.values(layout).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
      // MsgBlips column (left edge under the top chrome): up to 3 bubbles + the +N chip.
      { x: lay.gutterL, y: chromeBottom + 60, w: 56, h: 3 * 56 + 28 },
    ],
    [layout, lay.gutterL, chromeBottom],
  );
  const onViewport = useCallback(
    (b: Parameters<NonNullable<Parameters<typeof CrewMapView>[0]['onViewport']>>[0]) => {
      if (engine.hazards) engine.hazards.viewport = b;
    },
    [],
  );

  // Hardware back while guiding on Home asks before ending; when a child screen (like /drive-along) is open, back closes that screen instead.
  const segments = useSegments();
  const homeFocused = (segments as string[]).length === 0;
  const navActive = nav?.active === true;
  useEffect(() => {
    if (!navActive || !homeFocused) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      Alert.alert(t('nav.endConfirm'), '', [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('nav.end'), style: 'destructive', onPress: () => engine.nav.end() },
      ]);
      return true;
    });
    return () => sub.remove();
  }, [navActive, homeFocused]);

  const moment = notice.moment;
  const pill = notice.action === 'pill';
  const momentText = (() => {
    if (!moment) return '';
    if (moment.kind === 'passPlace') {
      const place = useApp.getState().places.find((p) => p.id === moment.placeId);
      return t('notif.passPlace', {
        name: friends[moment.owner]?.profile.name ?? '',
        place: place?.name ?? '',
      });
    }
    const name = (id: string) => friends[id]?.profile.name ?? useApp.getState().me?.name ?? '';
    return t('notif.friendsNear', { a: name(moment.a), b: name(moment.b), dist: `${moment.distanceM} m` });
  })();

  return (
    <View style={{ flex: 1 }}>
      <CrewMapView
        ref={map}
        onViewport={onViewport}
        ornaments={ornaments}
        onFriendPress={openFriend}
        onSelfPress={() => router.push('/avatar')}
        onHazardPress={(h) => router.push({ pathname: '/hazard/[id]', params: { id: h.id } })}
        onPlacePress={(p) => router.push({ pathname: '/place/[id]', params: { id: p.id } })}
        onLongPress={(lat, lng) => {
          // Answering "where do you want me?" with a dropped pin (D47): the long-press is the answer.
          if (pinFor) {
            void engine.asks.answerWhere(pinFor, { name: t('ask.pinName'), lat, lng }, pinNote ?? '');
            router.setParams({ pinFor: '', pinNote: '' });
            return;
          }
          router.push({ pathname: '/places/edit', params: { lat: String(lat), lng: String(lng) } });
        }}
      />

      {/* Top: navigation banners while guiding, otherwise search + settings */}
      <View
        style={[
          styles.top,
          {
            top: insets.top + 8,
            left: insets.left,
            right: wide ? 'auto' : insets.right,
            width: wide ? colW : undefined,
          },
        ]}
        onLayout={(e) => track('top')(e.nativeEvent.layout)}
      >
        {nav?.active && nav.progress ? (
          <NavBanners p={nav.progress} compact={wide} />
        ) : !plan.secondary ? null : (
          <View style={styles.searchRow}>
            <Bouncy
              testID="open-search"
              accessibilityLabel={t('map.search')}
              onPress={() => router.push('/search')}
              style={[styles.search, { backgroundColor: th.glass, borderColor: th.separator }, elevation.mid]}
            >
              <Icon name="search" size={22} color={th.textSoft} />
              <Text style={[type.body, { color: th.textSoft, flex: 1 }]}>{t('map.search')}</Text>
              {ghost && (
                <View
                  accessibilityLabel={t('map.ghost')}
                  style={[styles.ghost, { backgroundColor: th.accentSoft }]}
                >
                  <Icon name="ghost" size={18} color={th.accent} />
                </View>
              )}
            </Bouncy>
            {driving && (
              <IconButton
                testID="open-drive-along"
                icon="users"
                label={t('da.title')}
                size={54}
                onPress={() => router.push('/drive-along')}
              />
            )}
            {!driving && (
              <IconButton
                testID="open-settings"
                icon="settings"
                label={t('set.title')}
                size={54}
                onPress={() => router.push('/settings')}
              />
            )}
          </View>
        )}
        <View style={styles.syncRow}>
          <SyncChip />
          {driving && (queue.chip || notice.deferred > 0) && (
            <QueueChip count={(queue.chip?.count ?? 0) + notice.deferred} />
          )}
        </View>
        {!driving && <CrewFilterMenu />}
      </View>

      {!driving && (
        <View style={[styles.side, { top: sideTop, right: lay.gutterR }]}>
          <ControlGroup
            items={[
              {
                testID: 'open-crew',
                icon: 'crew',
                label: t('circle.title'),
                badge: crewUnread,
                onPress: () => router.push('/crew'),
              },
              {
                testID: 'open-stats',
                icon: 'trophy',
                label: t('stats.title'),
                onPress: () => router.push('/stats'),
              },
              {
                testID: 'open-trips',
                icon: 'car',
                label: t('trips.title'),
                onPress: () => router.push('/trips'),
              },
              {
                testID: 'open-places',
                icon: 'pin',
                label: t('places.title'),
                onPress: () => router.push('/places'),
              },
            ]}
          />
        </View>
      )}
      {driving && !plan.secondary ? null : showSheet && !wide && !driving ? (
        <Animated.View style={[styles.recenter, { right: lay.gutterR }, recenterSheet]}>
          <IconButton
            testID="recenter"
            icon="locate"
            label={t('map.me')}
            size={52}
            onPress={() => map.current?.recenter()}
          />
        </Animated.View>
      ) : (
        <View
          style={[
            styles.recenter,
            wide && driving
              ? { top: insets.top + 8 }
              : {
                  bottom: driving
                    ? layout.report
                      ? Math.max(insets.bottom + 264, lay.height - layout.report.y + 12)
                      : insets.bottom + 264
                    : wide && showSheet
                      ? insets.bottom + 24
                      : aboveCarousel,
                },
            { right: lay.gutterR },
          ]}
        >
          <IconButton
            testID="recenter"
            icon="locate"
            label={t('map.me')}
            size={52}
            onPress={() => map.current?.recenter()}
          />
        </View>
      )}

      {driving ? (
        <>
          <View
            style={[
              styles.speed,
              {
                bottom: insets.bottom + (wide ? 12 : 20),
                left: wide ? lay.gutterL + lay.panelW + 12 : lay.gutterL,
              },
            ]}
            onLayout={(e) => track('speed')(e.nativeEvent.layout)}
          >
            <MusicCard speedKmh={speedKmh} collapsed={!plan.secondary || undefined} />
            <SpeedBadge />
          </View>
          <View
            style={[styles.report, { bottom: insets.bottom + (wide ? 12 : 20), right: lay.gutterR }]}
            onLayout={(e) => track('report')(e.nativeEvent.layout)}
          >
            <ReportBar size={plan.primaryDp} music={<MusicButton size={plan.primaryDp} />} />
          </View>
          {nav?.active && (
            <View
              style={[
                styles.navFooter,
                wide
                  ? { left: lay.gutterL, width: lay.panelW, right: 'auto', bottom: insets.bottom + 12 }
                  : { bottom: insets.bottom + 20 },
                { backgroundColor: th.card },
                elevation.high,
              ]}
              onLayout={(e) => track('footer')(e.nativeEvent.layout)}
            >
              {nav.progress ? (
                <EtaPill
                  remainingS={nav.progress.remainingS}
                  remainingM={nav.progress.remainingM}
                  endDp={plan.primaryDp}
                  onEnd={() => engine.nav.end()}
                  onShare={() => router.push('/drive-along')}
                />
              ) : (
                <Bouncy
                  accessibilityLabel={t('nav.end')}
                  testID="nav-end"
                  onPress={() => engine.nav.end()}
                  style={[styles.endBtn, { backgroundColor: th.danger, minHeight: plan.primaryDp }]}
                >
                  <Text style={[type.headline, { color: '#FFFFFF' }]}>{t('nav.end')}</Text>
                </Bouncy>
              )}
            </View>
          )}
          <View style={[styles.still, { bottom: insets.bottom + (wide ? 112 : 140) }]}>
            <FasterOffer motion={motion} />
            <StillThere />
            <RouteNoticeBanner />
          </View>
          <CompanionOverlay top={layout.top ? layout.top.y + layout.top.height : insets.top + 64} />
        </>
      ) : showSheet ? (
        <CrewmateSheet
          height={sheetH}
          bottomInset={insets.bottom}
          leftInset={insets.left}
          topReserved={topReserved}
          wide={wide}
          panelW={lay.panelW}
          onFocus={focusFriend}
          onInvite={() => router.push('/crew')}
          onOpen={(f) => openFriend(f.profile.deviceId)}
        />
      ) : (
        <View
          style={[
            styles.carousel,
            { bottom: insets.bottom + 8, left: insets.left, height: DECK_VIEW_H },
            wide ? { width: lay.panelW + 28, right: 'auto' } : { right: insets.right },
          ]}
          onLayout={(e) => track('carousel')(e.nativeEvent.layout)}
        >
          {list.length === 0 ? null : (
            <CrewDeck
              ids={deckIds}
              renderCard={renderDeckCard}
              onFocus={focusFriend}
              onInvite={() => router.push('/crew')}
            />
          )}
          <FriendActions
            friend={actionsFor}
            onClose={() => setActionsFor(null)}
            onLocate={locateFriend}
            order={actionsFor ? { index: deckIds.indexOf(actionsFor.profile.deviceId), count: deckIds.length, onMove: moveDeck } : undefined}
          />
        </View>
      )}

      <GroupDriveCards top={layout.top ? layout.top.y + layout.top.height : insets.top + 64} />
      <AskCards top={layout.top ? layout.top.y + layout.top.height : insets.top + 64} />
      {!!pinFor && (
        <Toast
          testID="ask-pin-hint"
          tone="sun"
          icon="pin"
          message={t('ask.pinHint')}
          onPress={() => router.setParams({ pinFor: '', pinNote: '' })}
          style={{ position: 'absolute', top: insets.top + 12, left: 16, right: 16 }}
        />
      )}
      {moment && (
        <Toast
          testID="moment-toast"
          tone="sun"
          icon={moment.kind === 'passPlace' ? 'pin' : 'wave'}
          message={momentText}
          // While driving: a brief pill under the top stack (clear of the route, next turn and speed); browsing: above the carousel.
          style={
            pill
              ? [
                  styles.moment,
                  {
                    top: (layout.top ? layout.top.y + layout.top.height : insets.top + 64) + 4,
                    left: lay.gutterL,
                    maxWidth: wide ? lay.panelW : '60%',
                  },
                ]
              : [
                  styles.moment,
                  { bottom: aboveCarousel + 4, left: lay.gutterL, maxWidth: wide ? lay.panelW + 80 : '76%' },
                ]
          }
          onPress={notice.dismiss}
        />
      )}

      {!driving && (
        <View style={[styles.still, { bottom: aboveCarousel + 56 }]}>
          <TripEndCard />
        </View>
      )}


      {/* Chat bubbles: left edge, below the top chrome and the driving pill row; the side controls sit on the right. */}
      <MsgBlips top={chromeBottom + 60} left={lay.gutterL} />
      {driving && <MusicDrawer />}
      {locating && (
        <LocatePill
          id={locating}
          driving={driving}
          style={{
            left: wide ? lay.gutterL : insets.left + 12,
            width: wide ? lay.panelW : undefined,
            right: wide ? undefined : insets.right + 12,
            // Above the crew sheet / deck when browsing; above the speed, report and ETA boxes while driving.
            bottom: pillBottom(
              (driving ? [layout.speed, layout.report, layout.footer] : []).filter((r): r is LayoutRectangle => !!r),
              lay.height,
              driving ? insets.bottom + 20 : showSheet ? collapsedH + 8 : aboveCarousel,
              wide ? { x: lay.gutterL, width: lay.panelW } : { x: 0, width: lay.width },
            ),
          }}
        />
      )}
      <EmoteOverlay occupied={occupied} routePoints={[]} />
    </View>
  );
}

const styles = StyleSheet.create({
  top: { position: 'absolute', left: 0, right: 0 },
  syncRow: { flexDirection: 'row', marginHorizontal: 14, marginTop: 6 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 14 },
  search: {
    flex: 1,
    height: 54,
    borderRadius: 27,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  ghost: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  side: { position: 'absolute', right: 14 },
  recenter: { position: 'absolute', right: 14 },
  carousel: { position: 'absolute', left: 0, right: 0 },
  speed: { position: 'absolute', left: 14, gap: 10, alignItems: 'flex-start' },
  report: { position: 'absolute', right: 14 },
  still: { position: 'absolute', alignSelf: 'center' },
  navFooter: {
    position: 'absolute',
    left: 130,
    right: 100,
    minHeight: 80,
    borderRadius: radius.l,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  endBtn: { borderRadius: radius.m, paddingHorizontal: 18, minHeight: 48, justifyContent: 'center' },
  moment: { position: 'absolute', left: 14, maxWidth: '76%' },
});
