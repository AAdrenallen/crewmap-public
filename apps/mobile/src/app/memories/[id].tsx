import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeInDown, ZoomIn } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { platform } from '@crewmap/platform';
import { MEMORY_LIMITS } from '@crewmap/p2p';
import { lang, t } from '@crewmap/shared/i18n';
import { MEMORY_REACTIONS, assembleRecap, reactionSummary, type Recap, type TimelineItem } from '@crewmap/shared/memories';
import { formatClock, formatKm } from '@crewmap/shared/units';
import { engine } from '../../core/engine';
import { loadMemory, memoryTz, photoUri, useMemories, type StoredMemory } from '../../core/memories';
import { useApp } from '../../core/store';
import { ConfirmSheet } from '../../ui/ConfirmSheet';
import { Bouncy, Button, Card, Field, IconButton, ScreenHeader, SectionLabel, Toast } from '../../ui/kit';
import { Icon, type IconName } from '../../ui/kitIcons';
import { RouteThumb } from '../../ui/charts';
import { pageX, useLayoutMode } from '../../ui/layout';
import { AvatarStill } from '../../ui/map/Sprites';
import { PlaybackMap } from '../../ui/memories/PlaybackMap';
import { ShareCard, type ShareCardHandle } from '../../ui/memories/ShareCard';
import { HL_ICON, colorAt, emojiOf, hlLabel, hlValue, memoryDate, memoryTitle, usePeople } from '../../ui/memories/memoryUi';
import { font, palette, radius, type, useTheme } from '../../ui/theme';

const TL_ICON: Record<TimelineItem['kind'], IconName> = { start: 'car', join: 'users', leave: 'walk', stop: 'pin', emote: 'sparkle', photo: 'camera', end: 'check' };

/** One memory (D68): playback, reactions, highlights, who was there, places, timeline, photos, share card. */
export default function MemoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const th = useTheme();
  const { width } = useWindowDimensions();
  const rev = useMemories((s) => s.rev);
  const me = useApp((s) => s.me?.deviceId ?? '');
  const [mem, setMem] = useState<StoredMemory | null | undefined>(undefined);
  const [viewer, setViewer] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<'photo' | 'share' | null>(null);
  const card = useRef<ShareCardHandle>(null);

  useEffect(() => {
    let live = true;
    void loadMemory(id).then((m) => live && setMem(m), () => live && setMem(null));
    return () => {
      live = false;
    };
  }, [id, rev]);
  useEffect(() => {
    if (id) void engine.memories.markSeen(id);
  }, [id]);
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(h);
  }, [toast]);

  const recap: Recap | null = useMemo(
    () =>
      mem
        ? assembleRecap({ outing: mem.outing, me, myTrack: mem.myTrack, friendTracks: mem.friendTracks, posts: mem.posts, events: mem.events, photos: mem.photos, reacts: mem.reacts, tzMin: memoryTz() })
        : null,
    [mem, me],
  );
  const ids = useMemo(() => (mem ? [me, ...mem.outing.members.map((m) => m.id), ...mem.photos.map((p) => p.from)] : [me]), [mem, me]);
  const people = usePeople(ids);

  const addPhoto = useCallback(
    async (src: 'gallery' | 'camera') => {
      if (!mem) return;
      if (src === 'camera') return router.push({ pathname: '/memories/camera', params: { id: mem.id } });
      setBusy('photo');
      const r = await engine.memories.addPhoto(mem.id, 'gallery').catch(() => 'failed' as const);
      setBusy(null);
      if (r !== 'ok' && r !== 'canceled') setToast(t(`mem.photo.${r}`));
    },
    [mem, router],
  );

  const share = useCallback(async () => {
    if (!mem) return;
    setBusy('share');
    const uri = await card.current?.capture();
    const ok = uri ? await platform.photos.share(uri, 'image/png', memoryTitle({ ...(mem.title ? { title: mem.title } : {}), start: mem.outing.start })).catch(() => false) : false;
    setBusy(null);
    if (!ok) setToast(t('mem.shareFailed'));
  }, [mem]);

  if (mem === undefined) return <ActivityIndicator color={th.accent} style={{ flex: 1, backgroundColor: th.bg }} />;
  if (mem === null || !recap)
    return (
      <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 8, ...pageX(lay) }}>
        <ScreenHeader title={t('mem.title')} />
      </View>
    );

  const title = memoryTitle({ ...(mem.title ? { title: mem.title } : {}), start: mem.outing.start });
  const playable = recap.tracks.some((tr) => tr.pts.length >= 2);
  const myPhotos = mem.photos.filter((p) => p.from === me).length;
  const tile = Math.floor((Math.min(width, lay.wide ? 720 : width) - 32 - 16) / 3);
  const viewing = viewer ? mem.photos.find((p) => p.h === viewer) : undefined;
  const emojiTop = [...new Set(recap.timeline.filter((x) => x.kind === 'emote').map((x) => emojiOf(x.ref ?? '')))];
  const initials = mem.outing.members.map((m) => (people[m.id]?.name ?? '?').slice(0, 1).toUpperCase());

  return (
    <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 8 }}>
      <View style={{ ...pageX(lay) }}>
        <ScreenHeader
          title={title}
          right={<IconButton testID="mem-share" icon="share" tone="plain" label={t('mem.share')} disabled={busy === 'share'} onPress={() => void share()} />}
        />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {playable ? (
          <Animated.View entering={FadeIn.duration(300)}>
            <PlaybackMap tracks={recap.tracks} people={people} timeline={recap.timeline} height={lay.wide ? 300 : 340} />
          </Animated.View>
        ) : (
          <View style={[styles.hero, { backgroundColor: th.cardAlt }]}>
            <RouteThumb points={mem.posts.find((p) => p.route)?.route ?? []} color={th.accent} size={120} />
          </View>
        )}
        <View style={{ ...pageX(lay), gap: 18, paddingTop: 16 }}>
          <Text style={[type.caption, { color: th.textSoft }]}>
            {[mem.title ? memoryDate(mem.outing.start) : null, `${formatClock(mem.outing.start)}–${formatClock(mem.outing.end)}`, mem.outing.notable.length ? t(`mem.notable.${mem.outing.notable[0]!}`) : null].filter(Boolean).join(' · ')}
          </Text>
          <Reactions items={reactionSummary(mem.reacts, 'memory', me)} onToggle={(e) => void engine.memories.react(mem.id, 'memory', e)} testPrefix="mem-react" />

          <View style={styles.grid}>
            {recap.highlights.map((h, i) => (
              <Animated.View key={h.kind} entering={ZoomIn.delay(80 + i * 70).springify().damping(13)} style={styles.hlWrap}>
                <Card style={styles.hl}>
                  <View style={[styles.hlIcon, { backgroundColor: th.accentSoft }]}>
                    <Icon name={HL_ICON[h.kind]} size={18} color={th.accent} />
                  </View>
                  <Text testID={`mem-hl-${h.kind}`} style={[type.num, { color: th.text }]} numberOfLines={1} adjustsFontSizeToFit>
                    {hlValue(h)}
                  </Text>
                  <Text style={[type.caption, { color: th.textSoft }]} numberOfLines={2}>
                    {hlLabel(h, h.who ? (people[h.who]?.name ?? null) : null)}
                  </Text>
                </Card>
              </Animated.View>
            ))}
          </View>

          {mem.outing.members.length > 0 && (
            <View>
              <SectionLabel>{t('mem.crew')}</SectionLabel>
              <Card style={{ gap: 10 }}>
                {[{ id: me, joinedAt: mem.outing.start, leftAt: mem.outing.end }, ...mem.outing.members].map((m, i) => (
                  <Animated.View key={m.id} entering={FadeInDown.delay(i * 60).springify().damping(16)} style={styles.person}>
                    <View style={[styles.ring, { borderColor: colorAt(i) }]}>{people[m.id] && <AvatarStill avatar={people[m.id]!.avatar} size={36} />}</View>
                    <Text style={[type.body, font('semibold'), { color: th.text, flex: 1 }]} numberOfLines={1}>
                      {people[m.id]?.name}
                    </Text>
                    <Text style={[type.caption, { color: th.textSoft, fontVariant: ['tabular-nums'] }]}>
                      {formatClock(m.joinedAt)}–{formatClock(m.leftAt)}
                    </Text>
                  </Animated.View>
                ))}
              </Card>
            </View>
          )}

          {mem.outing.stops.some((s) => s.name) && (
            <View>
              <SectionLabel>{t('mem.places')}</SectionLabel>
              <View style={styles.chips}>
                {mem.outing.stops
                  .filter((s) => s.name)
                  .map((s, i) => (
                    <View key={`${s.start}`} style={[styles.place, { backgroundColor: th.card, borderColor: th.border }]}>
                      <Icon name="pin" size={15} color={colorAt(i + 1)} />
                      <Text style={[type.small, { color: th.text }]}>{s.name}</Text>
                      <Text style={[type.caption, { color: th.textSoft }]}>{formatClock(s.start)}</Text>
                    </View>
                  ))}
              </View>
            </View>
          )}

          <View>
            <SectionLabel>{t('mem.photos')}</SectionLabel>
            <View style={styles.photos}>
              {mem.photos.map((p, i) => {
                const uri = photoUri(p.h);
                return (
                  <Animated.View key={p.h} entering={ZoomIn.delay(i * 40).springify().damping(14)}>
                    <Bouncy testID={`mem-photo-${i}`} accessibilityRole="imagebutton" accessibilityLabel={p.cap ?? t('mem.photo')} onPress={() => setViewer(p.h)} style={[styles.photo, { width: tile, height: tile, backgroundColor: th.cardAlt }]}>
                      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} /> : <ActivityIndicator color={th.accent} />}
                      <View style={styles.photoBy}>{people[p.from] && <AvatarStill avatar={people[p.from]!.avatar} size={20} />}</View>
                    </Bouncy>
                  </Animated.View>
                );
              })}
              {myPhotos < MEMORY_LIMITS.photosPerMemberPerMemory && (
                <View style={[styles.addTile, { width: tile, height: tile, borderColor: th.border }]}>
                  {busy === 'photo' ? (
                    <ActivityIndicator color={th.accent} />
                  ) : (
                    <>
                      <IconButton testID="mem-add-gallery" icon="plus" tone="plain" label={t('mem.addGallery')} onPress={() => void addPhoto('gallery')} />
                      <IconButton testID="mem-add-camera" icon="camera" tone="plain" label={t('mem.addCamera')} onPress={() => void addPhoto('camera')} />
                    </>
                  )}
                </View>
              )}
            </View>
          </View>

          <View>
            <SectionLabel>{t('mem.timeline')}</SectionLabel>
            <Card style={{ gap: 2 }}>
              {recap.timeline.map((x, i) => (
                <View key={`${x.kind}${x.t}${i}`} style={styles.tl}>
                  <View style={styles.tlRail}>
                    <View style={[styles.tlDot, { backgroundColor: x.kind === 'emote' ? palette.sun : th.accentSoft }]}>
                      {x.kind === 'emote' ? <Text style={{ fontSize: 14 }}>{emojiOf(x.ref ?? '')}</Text> : <Icon name={TL_ICON[x.kind]} size={14} color={th.accent} />}
                    </View>
                    {i < recap.timeline.length - 1 && <View style={[styles.tlLine, { backgroundColor: th.border }]} />}
                  </View>
                  <Text style={[type.small, { color: th.text, flex: 1 }]} numberOfLines={2}>
                    {t(`mem.tl.${x.kind}`, { name: x.who ? (people[x.who]?.name ?? '') : '', place: x.kind === 'stop' ? (x.ref ?? t('mem.aStop')) : '' })}
                  </Text>
                  <Text style={[type.caption, { color: th.textSoft, fontVariant: ['tabular-nums'] }]}>{formatClock(x.t)}</Text>
                </View>
              ))}
            </Card>
          </View>

          {renaming !== null ? (
            <View style={{ gap: 10 }}>
              <Field testID="mem-title-input" label={t('mem.rename')} value={renaming} maxLength={MEMORY_LIMITS.maxTitle} autoFocus onChangeText={setRenaming} onClear={() => setRenaming('')} />
              <Button
                testID="mem-title-save"
                label={t('common.save')}
                onPress={() => {
                  void engine.memories.rename(mem.id, renaming);
                  setRenaming(null);
                }}
              />
            </View>
          ) : (
            <View style={styles.actions}>
              <Button testID="mem-keep" kind={mem.kept ? 'primary' : 'secondary'} icon="heart" label={mem.kept ? t('mem.kept') : t('mem.keep')} onPress={() => void engine.memories.setKept(mem.id, !mem.kept)} compact />
              <Button testID="mem-rename" kind="ghost" label={t('mem.rename')} onPress={() => setRenaming(mem.title ?? '')} compact />
              <Button testID="mem-delete" kind="ghost" label={t('mem.delete')} onPress={() => setConfirm(true)} compact />
            </View>
          )}
          {mem.outing.distanceM > 0 && !playable && <Text style={[type.caption, { color: th.textFaint }]}>{formatKm(mem.outing.distanceM / 1000, lang())}</Text>}
        </View>
      </ScrollView>

      <ShareCard ref={card} title={title} date={memoryDate(mem.outing.start)} route={mem.myTrack} highlights={recap.highlights} initials={initials} emoji={emojiTop} />

      <Modal visible={!!viewing} transparent animationType="fade" onRequestClose={() => setViewer(null)} statusBarTranslucent>
        {viewing && (
          <View style={[styles.viewer, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.viewerTop}>
              <IconButton testID="mem-viewer-close" icon="close" label={t('common.close')} onPress={() => setViewer(null)} />
              {viewing.from === me && (
                <IconButton
                  testID="mem-viewer-remove"
                  icon="trash"
                  tone="danger"
                  label={t('mem.photo.remove')}
                  onPress={() => {
                    setViewer(null);
                    void engine.memories.removePhoto(mem.id, viewing.h);
                  }}
                />
              )}
            </View>
            <Pressable style={{ flex: 1, justifyContent: 'center' }} onPress={() => setViewer(null)} accessibilityLabel={t('common.close')}>
              {photoUri(viewing.h) && <Image source={{ uri: photoUri(viewing.h)! }} resizeMode="contain" style={{ width: '100%', aspectRatio: viewing.w / viewing.hgt, maxHeight: '100%' }} />}
            </Pressable>
            <View style={{ gap: 10, paddingHorizontal: 16 }}>
              <Text style={[type.small, { color: '#fff' }]}>
                {[people[viewing.from]?.name, viewing.cap, formatClock(viewing.at)].filter(Boolean).join(' · ')}
              </Text>
              <Reactions dark items={reactionSummary(mem.reacts, viewing.h, me)} onToggle={(e) => void engine.memories.react(mem.id, viewing.h, e)} testPrefix="mem-photo-react" />
            </View>
          </View>
        )}
      </Modal>
      <ConfirmSheet
        visible={confirm}
        title={t('mem.deleteQ')}
        confirmLabel={t('mem.delete')}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void engine.memories.remove(mem.id).then(() => (router.canGoBack() ? router.back() : router.replace('/memories')));
        }}
      />
      {toast && <Toast testID="mem-toast" message={toast} style={{ position: 'absolute', alignSelf: 'center', bottom: insets.bottom + 24 }} />}
    </View>
  );
}

/** The reaction row: every reaction, counted, mine highlighted; tap toggles with a bounce. */
function Reactions({ items, onToggle, testPrefix, dark }: { items: { e: string; n: number; mine: boolean }[]; onToggle: (e: string) => void; testPrefix: string; dark?: boolean }) {
  const th = useTheme();
  return (
    <View style={styles.reacts}>
      {MEMORY_REACTIONS.map((e, i) => {
        const it = items.find((x) => x.e === e);
        return (
          <Bouncy
            key={e}
            testID={`${testPrefix}-${i}`}
            accessibilityRole="button"
            accessibilityState={{ selected: !!it?.mine }}
            accessibilityLabel={`${e} ${it?.n ?? 0}`}
            haptic="bounce"
            scaleTo={0.8}
            onPress={() => onToggle(e)}
            style={[styles.react, { backgroundColor: it?.mine ? th.accentSoft : dark ? 'rgba(255,255,255,0.12)' : th.card, borderColor: it?.mine ? th.accent : dark ? 'transparent' : th.border }]}
          >
            <Text style={{ fontSize: 18 }}>{e}</Text>
            {!!it?.n && <Text style={[type.caption, font('bold'), { color: dark && !it.mine ? '#fff' : th.text }]}>{it.n}</Text>}
          </Bouncy>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { height: 180, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  hlWrap: { width: '48.5%' },
  hl: { padding: 14, gap: 6, minHeight: 124 },
  hlIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  ring: { width: 44, height: 44, borderRadius: 22, borderWidth: 3, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  place: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, minHeight: 36, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photo: { borderRadius: 16, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  photoBy: { position: 'absolute', left: 6, bottom: 6, width: 24, height: 24, borderRadius: 12, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.3)', alignItems: 'center', justifyContent: 'center' },
  addTile: { borderRadius: 16, borderWidth: 2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  tl: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 40 },
  tlRail: { width: 28, alignItems: 'center' },
  tlDot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  tlLine: { width: 2, flex: 1, minHeight: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  reacts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  react: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, minHeight: 44, borderRadius: radius.pill, borderWidth: 1 },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', gap: 12 },
  viewerTop: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16 },
});
