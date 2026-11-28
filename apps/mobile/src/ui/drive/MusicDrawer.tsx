import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { platform, type MediaAction, type MediaBrowseItem } from '@crewmap/platform';
import { t } from '@crewmap/shared/i18n';
import { Icon } from '../kitIcons';
import { useLayoutMode } from '../layout';
import { elevation, font, radius, type, useTheme } from '../theme';
import { useNowPlaying } from './MusicCard';
import { MusicIcon, type MusicGlyph } from './MusicIcons';
import { useMusicUi } from './musicState';

const QUICK_MIXES: { id: string; query: string; labelKey: 'music.liked' | 'music.dailyMix' | 'music.discover' | 'music.releaseRadar' | 'music.drivingMix'; tint: string }[] = [
  { id: 'liked', query: 'Liked Songs', labelKey: 'music.liked', tint: '#1DB954' },
  { id: 'driving', query: 'Driving Mix', labelKey: 'music.drivingMix', tint: '#5B6CFF' },
  { id: 'daily', query: 'Daily Mix 1', labelKey: 'music.dailyMix', tint: '#F5A524' },
  { id: 'discover', query: 'Discover Weekly', labelKey: 'music.discover', tint: '#8E5CF2' },
  { id: 'radar', query: 'Release Radar', labelKey: 'music.releaseRadar', tint: '#FF5A6A' },
];

/**
 * Comfortable slide-in in-app music player for Spotify or any chosen media app:
 * - Full Now Playing transport controls + app selector + scrollable Playlists/Mixes & Up Next queue!
 * - Keeps navigation turn banners visible; swipe down / right or tap outside to dismiss cleanly.
 */
export function MusicDrawer() {
  const open = useMusicUi((s) => s.drawerOpen);
  const close = useMusicUi((s) => s.closeDrawer);
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const np = useNowPlaying();

  const [hasAccess, setHasAccess] = useState(() => platform.os === 'android' && platform.media.hasAccess());
  const [apps] = useState(() => (platform.os === 'android' ? platform.media.installed() : []));
  const [selectedPkg, setSelectedPkg] = useState<string | null>(() => (platform.os === 'android' ? platform.media.preferred() : null));
  const [items, setItems] = useState<MediaBrowseItem[]>([]);
  const [folderStack, setFolderStack] = useState<{ id: string; title: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const slide = useRef(new Animated.Value(0)).current;
  const dragY = useRef(new Animated.Value(0)).current;

  const activePkg = selectedPkg ?? np?.pkg ?? apps[0]?.pkg ?? null;
  const activeLabel = useMemo(
    () => apps.find((a) => a.pkg === activePkg)?.label ?? np?.app ?? t('music.open'),
    [apps, activePkg, np?.app],
  );
  const currentParent = folderStack.length > 0 ? folderStack[folderStack.length - 1]!.id : null;

  useEffect(() => {
    if (!open) return;
    setHasAccess(platform.os === 'android' && platform.media.hasAccess());
    dragY.setValue(0);
    slide.setValue(0);
    Animated.spring(slide, { toValue: 1, useNativeDriver: true, friction: 8, tension: 75 }).start();
  }, [open, slide, dragY]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (folderStack.length > 0) {
        setFolderStack((st) => st.slice(0, -1));
        return true;
      }
      close();
      return true;
    });
    return () => sub.remove();
  }, [open, folderStack.length, close]);

  const loadBrowse = useCallback(async () => {
    if (!open || platform.os !== 'android' || !activePkg) return;
    setLoading(true);
    const res = await platform.media.browse(activePkg, currentParent);
    setItems(res);
    setLoading(false);
  }, [open, activePkg, currentParent]);

  useEffect(() => {
    void loadBrowse();
  }, [loadBrowse, np?.title]);

  const dismissAnimated = useCallback(() => {
    Animated.timing(slide, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => close());
  }, [slide, close]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 12 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => dragY.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_, g) => {
        if (g.dy > 72 || g.vy > 0.75) dismissAnimated();
        else Animated.spring(dragY, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
      },
    }),
  ).current;

  if (!open || platform.os !== 'android') return null;

  const chooseApp = (pkg: string) => {
    platform.media.setPreferred(pkg);
    setSelectedPkg(pkg);
    setFolderStack([]);
  };

  const act = (a: MediaAction) => {
    if (!platform.media.control(a) && activePkg) {
      platform.media.playItem(activePkg, 'search', '');
    }
  };

  const onTapItem = (it: MediaBrowseItem) => {
    if (it.browsable || it.kind === 'folder') {
      setFolderStack((st) => [...st, { id: it.id, title: it.title }]);
      return;
    }
    const kind = it.kind === 'queue' ? 'queue' : it.kind === 'search' ? 'search' : 'media';
    platform.media.playItem(activePkg, kind, it.id);
  };

  const playlists = items.filter((i) => i.kind !== 'queue');
  const queue = items.filter((i) => i.kind === 'queue');

  const transportBtn = (glyph: MusicGlyph, label: string, onPress: () => void, primary = false, testID?: string) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tBtn,
        primary ? { width: 64, height: 64, borderRadius: 32, backgroundColor: th.accent } : { width: 52, height: 52, borderRadius: 26, backgroundColor: th.cardAlt },
        pressed && { opacity: 0.75 },
      ]}
    >
      <MusicIcon name={glyph} size={primary ? 32 : 26} color={primary ? th.onAccent : th.text} />
    </Pressable>
  );

  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.layer]}>
      <Pressable testID="music-drawer-backdrop" accessibilityRole="button" accessibilityLabel={t('common.close')} style={styles.backdrop} onPress={dismissAnimated} />
      <Animated.View
        testID="music-drawer"
        style={[
          styles.drawer,
          lay.wide
            ? { right: insets.right + 12, bottom: insets.bottom + 12, width: Math.min(390, lay.width * 0.48), maxHeight: lay.height - insets.top - insets.bottom - 24 }
            : { left: 10, right: 10, bottom: insets.bottom + 12, maxHeight: Math.min(500, lay.height * 0.62) },
          {
            backgroundColor: th.card,
            borderColor: th.border,
            opacity: slide,
            transform: [
              {
                translateY: Animated.add(
                  slide.interpolate({ inputRange: [0, 1], outputRange: [260, 0] }),
                  dragY,
                ),
              },
            ],
          },
          elevation.high,
        ]}
      >
        {/* Drag handle + header */}
        <View {...pan.panHandlers} style={[styles.headerArea, { borderBottomColor: th.separator }]}>
          <View style={[styles.grabber, { backgroundColor: th.border }]} />
          <View style={styles.headRow}>
            {folderStack.length > 0 ? (
              <Pressable onPress={() => setFolderStack((st) => st.slice(0, -1))} hitSlop={8} style={styles.iconHit}>
                <Icon name="back" size={20} color={th.text} />
              </Pressable>
            ) : (
              <MusicIcon name="note" size={22} color={th.accent} />
            )}
            <Text style={[type.headline, font('bold'), { color: th.text, flex: 1 }]} numberOfLines={1}>
              {folderStack.length > 0 ? folderStack[folderStack.length - 1]!.title : activeLabel}
            </Text>
            {activePkg && (
              <Pressable
                testID="music-open-external"
                accessibilityRole="button"
                accessibilityLabel={t('music.openApp', { app: activeLabel })}
                onPress={() => {
                  platform.media.playItem(activePkg, 'open', '');
                  close();
                }}
                style={[styles.openChip, { backgroundColor: th.cardAlt, borderColor: th.border }]}
              >
                <Text style={[type.caption, font('semibold'), { color: th.textSoft }]}>{t('music.openApp', { app: activeLabel })}</Text>
              </Pressable>
            )}
            <Pressable testID="music-drawer-close" accessibilityRole="button" accessibilityLabel={t('common.close')} hitSlop={8} onPress={dismissAnimated} style={styles.iconHit}>
              <Icon name="close" size={20} color={th.textSoft} />
            </Pressable>
          </View>

          {/* App switcher chips */}
          {apps.length > 1 && folderStack.length === 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.appChips}>
              {apps.map((a) => {
                const active = a.pkg === activePkg;
                return (
                  <Pressable
                    key={a.pkg}
                    testID={`music-app-${a.pkg}`}
                    onPress={() => chooseApp(a.pkg)}
                    style={[
                      styles.appChip,
                      { backgroundColor: active ? th.accentSoft : th.cardAlt, borderColor: active ? th.accent : th.border },
                    ]}
                  >
                    <Text style={[type.caption, font('bold'), { color: active ? th.accent : th.textSoft }]}>{a.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </View>

        {!hasAccess ? (
          <View style={styles.accessBox}>
            <Text style={[type.small, { color: th.textSoft, textAlign: 'center' }]}>{t('music.noAccess')}</Text>
            <Pressable
              testID="music-grant-access"
              onPress={() => void platform.externalNavStatus.requestAccess()}
              style={[styles.grantBtn, { backgroundColor: th.accent }]}
            >
              <Text style={[type.small, font('bold'), { color: th.onAccent }]}>{t('set.navStatus')}</Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            {/* Now Playing Hero + Transport */}
            {folderStack.length === 0 && (
              <View style={[styles.nowBox, { backgroundColor: th.cardAlt }]}>
                <View style={styles.nowRow}>
                  {np?.art ? (
                    <Image source={{ uri: np.art }} style={styles.cover} />
                  ) : (
                    <View style={[styles.cover, styles.coverPlaceholder, { backgroundColor: th.separator }]}>
                      <MusicIcon name="note" size={28} color={th.textSoft} />
                    </View>
                  )}
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[type.headline, font('bold'), { color: th.text }]} numberOfLines={1}>
                      {np?.title ?? activeLabel}
                    </Text>
                    {np?.artist ? (
                      <Text style={[type.small, { color: th.textSoft }]} numberOfLines={1}>
                        {np.artist}
                      </Text>
                    ) : null}
                  </View>
                </View>
                <View style={styles.transportRow}>
                  {transportBtn('prev', t('music.prev'), () => act('previous'), false, 'music-drawer-prev')}
                  {transportBtn(np?.playing ? 'pause' : 'play', t(np?.playing ? 'music.pause' : 'music.play'), () => act('toggle'), true, 'music-drawer-toggle')}
                  {transportBtn('next', t('music.next'), () => act('next'), false, 'music-drawer-next')}
                  {np?.canNextPlaylist && transportBtn('list', t('music.nextPlaylist'), () => act('nextPlaylist'), false, 'music-drawer-next-list')}
                </View>
              </View>
            )}

            {/* Quick Playlists & Browsed MediaBrowser Folders/Playlists */}
            <View style={{ gap: 8 }}>
              <Text style={[type.caption, font('bold'), { color: th.textSoft, textTransform: 'uppercase', letterSpacing: 0.5 }]}>
                {t('music.playlists')}
              </Text>

              {folderStack.length === 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.mixScroller}>
                  {QUICK_MIXES.map((m) => (
                    <Pressable
                      key={m.id}
                      testID={`music-mix-${m.id}`}
                      onPress={() => platform.media.playItem(activePkg, 'search', m.query)}
                      style={({ pressed }) => [
                        styles.mixTile,
                        { backgroundColor: th.cardAlt, borderColor: th.border, opacity: pressed ? 0.75 : 1 },
                      ]}
                    >
                      <View style={[styles.mixBadge, { backgroundColor: `${m.tint}24` }]}>
                        <MusicIcon name="play" size={18} color={m.tint} />
                      </View>
                      <Text style={[type.small, font('bold'), { color: th.text }]} numberOfLines={2}>
                        {t(m.labelKey)}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              )}

              {loading && <ActivityIndicator size="small" color={th.accent} style={{ marginVertical: 6 }} />}

              {playlists.map((it) => (
                <Pressable
                  key={`pl-${it.id}`}
                  testID={`music-item-${it.id}`}
                  onPress={() => onTapItem(it)}
                  style={({ pressed }) => [
                    styles.itemRow,
                    { backgroundColor: pressed ? th.cardAlt : 'transparent', borderColor: th.separator },
                  ]}
                >
                  {it.art ? (
                    <Image source={{ uri: it.art }} style={styles.itemArt} />
                  ) : (
                    <View style={[styles.itemArt, styles.coverPlaceholder, { backgroundColor: th.cardAlt }]}>
                      <MusicIcon name={it.browsable ? 'list' : 'play'} size={18} color={th.accent} />
                    </View>
                  )}
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={[type.body, font('semibold'), { color: th.text }]} numberOfLines={1}>
                      {it.title}
                    </Text>
                    {it.subtitle ? (
                      <Text style={[type.caption, { color: th.textSoft }]} numberOfLines={1}>
                        {it.subtitle}
                      </Text>
                    ) : null}
                  </View>
                  <Icon name={it.browsable ? 'chevronRight' : 'chevron'} size={16} color={th.textSoft} />
                </Pressable>
              ))}
            </View>

            {/* Active Session Queue ("Up next") */}
            {folderStack.length === 0 && queue.length > 0 && (
              <View style={{ gap: 6 }}>
                <Text style={[type.caption, font('bold'), { color: th.textSoft, textTransform: 'uppercase', letterSpacing: 0.5 }]}>
                  {t('music.queue')}
                </Text>
                {queue.map((q) => (
                  <Pressable
                    key={`q-${q.id}`}
                    testID={`music-queue-${q.id}`}
                    onPress={() => onTapItem(q)}
                    style={({ pressed }) => [
                      styles.itemRow,
                      { backgroundColor: pressed ? th.cardAlt : 'transparent', borderColor: th.separator },
                    ]}
                  >
                    <View style={[styles.itemArt, styles.coverPlaceholder, { backgroundColor: th.cardAlt }]}>
                      <MusicIcon name="play" size={16} color={th.textSoft} />
                    </View>
                    <View style={{ flex: 1, gap: 1 }}>
                      <Text style={[type.small, font('semibold'), { color: th.text }]} numberOfLines={1}>
                        {q.title}
                      </Text>
                      {q.subtitle ? (
                        <Text style={[type.caption, { color: th.textSoft }]} numberOfLines={1}>
                          {q.subtitle}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { zIndex: 28 },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.22)' },
  drawer: {
    position: 'absolute',
    borderRadius: radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },
  headerArea: { paddingTop: 8, paddingBottom: 10, paddingHorizontal: 14, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  grabber: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center' },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconHit: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  openChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  appChips: { gap: 6, paddingTop: 2 },
  appChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, borderWidth: 1 },
  accessBox: { padding: 20, alignItems: 'center', gap: 12 },
  grantBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  body: { padding: 14, gap: 14 },
  nowBox: { borderRadius: radius.l, padding: 12, gap: 12 },
  nowRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cover: { width: 56, height: 56, borderRadius: 14 },
  coverPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  transportRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
  tBtn: { alignItems: 'center', justifyContent: 'center' },
  mixScroller: { gap: 8, paddingVertical: 2 },
  mixTile: { width: 118, padding: 10, borderRadius: radius.m, borderWidth: StyleSheet.hairlineWidth, gap: 8 },
  mixBadge: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: radius.s,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  itemArt: { width: 38, height: 38, borderRadius: 8 },
});
