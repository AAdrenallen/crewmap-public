import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { haversineM } from '@crewmap/shared/geo';
import { searchPlaces } from '@crewmap/shared/places';
import { formatDistance } from '@crewmap/shared/units';
import { lang, t } from '@crewmap/shared/i18n';
import { hasPlace, RequestSeq, type SavedPlace } from '@crewmap/shared/navigation';
import { hasMapboxToken, searchForward, type SearchResult } from '../core/mapbox';
import { engine } from '../core/engine';
import { addRecent, clearRecent, loadFavourites, loadRecent, removeRecent, toggleFav } from '../core/searchHistory';
import { useApp } from '../core/store';
import { useBackClose } from '../ui/useBackClose';
import { FuelResults } from '../ui/FuelResults';
import { isFuelQuery } from '@crewmap/hazards';
import { Bouncy, EmptyState, Field, IconButton, IconTile, ListItem, type IconName } from '../ui/kit';
import { AvatarStill } from '../ui/map/Sprites';
import { palette, type, useTheme } from '../ui/theme';
import { IconTile as PlaceTile } from '../ui/screens-common/Icon';
import { PLACE_TYPE_ICON } from '../ui/places';
import type { PlaceType } from '@crewmap/shared/places';
import type { AvatarConfig } from '@crewmap/shared/avatar';

interface Hit {
  key: string;
  icon: IconName;
  tint: string;
  avatar?: AvatarConfig;
  placeType?: PlaceType;
  header?: 'saved' | 'recent' | 'places';
  /** Set for results that can be starred / recorded (not friends or places). */
  place?: SavedPlace;
  /** Recent row: can be removed. */
  recent?: boolean;
  name: string;
  sub: string;
  lat: number;
  lng: number;
}

/** Search: "Your places" (mine + friends' shared, name/word/substring/type match) and friends first (local, free), then Mapbox Search Box (debounced 350 ms, ≥ 3 chars). */
export default function Search() {
  const router = useRouter();
  /** Crewmates preselected for a group drive, or picking a custom starting point for /route. */
  const { with: withIds, answer, pickOrigin, destName, destLat, destLng, fromName, fromLat, fromLng } = useLocalSearchParams<{
    with?: string;
    answer?: string;
    pickOrigin?: string;
    destName?: string;
    destLat?: string;
    destLng?: string;
    fromName?: string;
    fromLat?: string;
    fromLng?: string;
  }>();
  /** Answering "where do you want me?" (D47): a pick sends the place instead of opening a route. */
  const [note, setNote] = useState('');
  const [answerErr, setAnswerErr] = useState(false);
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const fix = useApp((s) => s.fix);
  const me = useApp((s) => s.me);
  const places = useApp((s) => s.places);
  const friends = useApp((s) => s.friends);
  const online = useApp((s) => s.online);
  const [attempt, setAttempt] = useState(0);
  const [recent, setRecent] = useState<SavedPlace[]>([]);
  const [saved, setSaved] = useState<SavedPlace[]>([]);
  const seq = useRef(new RequestSeq());
  // A GPS fix must not restart a query in flight, so the effect reads the position through a ref.
  const fixRef = useRef(fix);
  fixRef.current = fix;

  useEffect(() => {
    let alive = true;
    void Promise.all([loadRecent(), loadFavourites()]).then(([r, f]) => {
      if (!alive) return;
      setRecent(r);
      setSaved(f);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const s = seq.current;
    setFailed(false);
    // Generic fuel words are answered from the on-device station cache (FuelResults), not Mapbox (D64).
    if (q.trim().length < 3 || !hasMapboxToken() || !online || isFuelQuery(q)) {
      s.cancel();
      setRemote([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      const ticket = s.next();
      searchForward(q.trim(), fixRef.current, lang()).then(
        (r) => {
          if (!s.isCurrent(ticket)) return;
          setRemote(r);
          setLoading(false);
        },
        () => {
          if (!s.isCurrent(ticket)) return;
          setRemote([]);
          setFailed(true);
          setLoading(false);
        },
      );
    }, 350);
    return () => {
      clearTimeout(timer);
      // Drop any response still in flight for the previous query (or after unmount).
      s.cancel();
    };
  }, [q, attempt, online]);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  useBackClose(close);
  const toPlace = (s: SearchResult): SavedPlace => ({ id: s.id, name: s.name, address: s.address, lat: s.lat, lng: s.lng });
  const reply = async (name: string, lat: number, lng: number) => {
    const ok = await engine.asks.answerWhere(answer!, { name, lat, lng }, note);
    if (ok) close();
    else setAnswerErr(true);
  };
  const go = (name: string, lat: number, lng: number, place?: SavedPlace) => {
    if (place) void addRecent(place);
    if (answer) {
      void reply(name, lat, lng);
      return;
    }
    if (pickOrigin === '1' && destLat && destLng) {
      router.replace({
        pathname: '/route',
        params: {
          name: destName ?? '',
          lat: destLat,
          lng: destLng,
          fromName: name,
          fromLat: String(lat),
          fromLng: String(lng),
          ...(withIds ? { with: withIds } : {}),
        },
      });
      return;
    }
    router.replace({
      pathname: '/route',
      params: {
        name,
        lat: String(lat),
        lng: String(lng),
        ...(fromLat && fromLng ? { fromName: fromName ?? '', fromLat, fromLng } : {}),
        ...(withIds ? { with: withIds } : {}),
      },
    });
  };

  const hits: Hit[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const local: Hit[] = [
      ...(needle ? searchPlaces(q, places) : places).map((p) => ({ key: `p-${p.id}`, icon: 'pin' as IconName, placeType: p.type, tint: p.color, name: p.name, sub: [t(`placeType.${p.type}`), friends[p.owner]?.profile.name].filter(Boolean).join(' · '), lat: p.lat, lng: p.lng })),
      ...Object.values(friends)
        .filter((f) => f.presence && !f.paused && (!needle || f.profile.name.toLowerCase().includes(needle)))
        .map((f) => ({ key: `f-${f.profile.deviceId}`, icon: 'person' as IconName, tint: palette.brand, avatar: f.profile.avatar, name: f.profile.name, sub: t(`act.${f.presence!.act}`), lat: f.presence!.lat, lng: f.presence!.lng })),
    ];
    const r: Hit[] = remote.map((s) => ({ key: `r-${s.id}`, icon: s.category ? 'store' : 'pin', tint: s.category ? palette.mint : th.textSoft, place: toPlace(s), name: s.name, sub: s.address, lat: s.lat, lng: s.lng }));
    const asHit = (p: SavedPlace, prefix: string, isRecent: boolean): Hit => ({ key: `${prefix}-${p.id}`, icon: 'pin', tint: th.textSoft, place: p, recent: isRecent, name: p.name, sub: p.address, lat: p.lat, lng: p.lng });
    const match = (p: SavedPlace) => !needle || p.name.toLowerCase().includes(needle) || p.address.toLowerCase().includes(needle);
    const section = (header: Hit['header'], title: string, rows: Hit[]): Hit[] => (rows.length ? [{ key: `h-${header}`, header, icon: 'pin', tint: '', name: title, sub: '', lat: 0, lng: 0 }, ...rows] : []);
    const savedRows = saved.filter(match).map((p) => asHit(p, 's', false));
    const recentRows = needle ? [] : recent.map((p) => asHit(p, 'rc', true));
    // "Your places" are the places feature's own list (not duplicated into Saved).
    const placeRows = section('places', t('places.yours'), local.filter((h) => h.placeType));
    const friendRows = local.filter((h) => !h.placeType);
    const remoteRows = r.filter((h) => !savedRows.some((s) => s.place && h.place && s.place.id === h.place.id));
    return [...section('saved', t('search.saved'), savedRows), ...section('recent', t('search.recent'), recentRows), ...placeRows, ...friendRows, ...remoteRows];
  }, [q, places, friends, remote, saved, recent, th.textSoft]);

  const searching = q.trim().length >= 3;
  const retry = { label: t('common.retry'), onPress: () => setAttempt((n) => n + 1) };
  const empty = () => {
    if (loading) return <ActivityIndicator style={{ marginTop: 32 }} color={th.accent} />;
    if (searching && !online) return <EmptyState testID="search-offline" icon="alert" title={t('search.offline')} action={retry} />;
    if (failed) return <EmptyState testID="search-error" icon="alert" title={t('search.error')} action={retry} />;
    if (q.trim().length > 0) return <EmptyState testID="search-empty" icon="search" title={t('common.noResults')} />;
    return <EmptyState testID="search-start" icon="search" title={t('search.start')} />;
  };
  // Local results may be showing while the network part is loading, offline or failed: say so below them.
  const footer = () => {
    if (hits.length === 0) return undefined;
    if (loading) return <ActivityIndicator style={{ marginVertical: 16 }} color={th.accent} />;
    if (searching && !online) return <Text testID="search-offline-note" style={[type.small, { color: th.textSoft, textAlign: 'center', paddingVertical: 16 }]}>{t('search.offline')}</Text>;
    if (failed) return <EmptyState testID="search-error" icon="alert" title={t('search.error')} action={retry} />;
    return undefined;
  };

  const star = async (p: SavedPlace) => setSaved(await toggleFav(p));
  const drop = async (p: SavedPlace) => setRecent(await removeRecent(p));
  const wipe = async () => setRecent(await clearRecent());
  const renderSep = useCallback(() => <View style={[styles.sep, { backgroundColor: th.separator }]} />, [th.separator]);

  return (
    <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 8 }}>
      <View style={styles.bar}>
        <IconButton testID="search-back" icon="back" tone="plain" label={t('common.back')} onPress={close} />
        <View style={{ flex: 1 }}>
          <Field testID="search-input" label={pickOrigin === '1' ? t('route.pickStart') : t('map.search')} hideLabel placeholder={pickOrigin === '1' ? t('route.pickStart') : t('map.search')} icon="search" value={q} onChangeText={setQ} onClear={() => setQ('')} autoFocus returnKeyType="search" />
        </View>
      </View>
      {!!answer && (
        <View style={styles.answer}>
          <Field testID="ask-note" label={t('ask.note')} hideLabel placeholder={t('ask.note')} icon="chat" value={note} onChangeText={setNote} maxLength={80} />
          {answerErr && <Text style={[type.small, { color: th.danger }]}>{t('friend.etaFailed')}</Text>}
          {!!fix && (
            <ListItem testID="ask-here" title={t('ask.here')} leading={<IconTile icon="locate" color={th.accent} />} onPress={() => void reply(t('ask.hereName', { name: me?.name ?? '' }), fix.lat, fix.lng)} />
          )}
          <ListItem testID="ask-pin" title={t('ask.pin')} leading={<IconTile icon="pin" color={palette.pop} />} onPress={() => router.replace({ pathname: '/', params: { pinFor: answer, ...(note.trim() ? { pinNote: note.trim() } : {}) } })} />
        </View>
      )}
      <FlatList
        data={hits}
        keyExtractor={(h) => h.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
        ItemSeparatorComponent={renderSep}
        ListHeaderComponent={isFuelQuery(q) ? <FuelResults onPick={(name, lat, lng) => go(name, lat, lng)} /> : undefined}
        ListEmptyComponent={empty}
        ListFooterComponent={footer()}
        renderItem={({ item }) => item.header ? (
          <View style={styles.sectionRow}>
            <Text testID={`search-${item.header}-header`} style={[type.small, { color: th.textSoft, fontWeight: '700', flex: 1 }]}>{item.name}</Text>
            {item.header === 'recent' ? (
              <Bouncy testID="search-clear-recent" accessibilityRole="button" accessibilityLabel={t('search.clearAll')} onPress={() => void wipe()} hitSlop={8}>
                <Text style={[type.small, { color: th.accent, fontWeight: '700' }]}>{t('search.clearAll')}</Text>
              </Bouncy>
            ) : null}
          </View>
        ) : (
          <ListItem
            testID={`search-hit-${item.name}`}
            title={item.name}
            subtitle={item.sub}
            onPress={() => go(item.name, item.lat, item.lng, item.place)}
            onLongPress={item.recent && item.place ? () => void drop(item.place!) : undefined}
            leading={
              item.placeType ? (
                <PlaceTile name={PLACE_TYPE_ICON[item.placeType]} color={item.tint} size={40} />
              ) : item.avatar ? (
                <View style={[styles.avatar, { backgroundColor: th.cardAlt }]}>
                  <AvatarStill avatar={item.avatar} size={40} />
                </View>
              ) : (
                <IconTile icon={item.icon} color={item.tint} />
              )
            }
            trailing={
              <View style={styles.trail}>
                {fix ? <Text style={[type.small, { color: th.textSoft }]}>{formatDistance(haversineM(fix, item), lang())}</Text> : null}
                {item.place ? (
                  <IconButton
                    testID={`search-star-${item.place.id}`}
                    icon="star"
                    tone="plain"
                    size={40}
                    active={hasPlace(saved, item.place)}
                    label={t(hasPlace(saved, item.place) ? 'search.unsave' : 'search.save')}
                    onPress={() => void star(item.place!)}
                  />
                ) : null}
                {item.recent && item.place ? <IconButton testID={`search-remove-${item.place.id}`} icon="close" tone="plain" size={40} label={t('search.remove')} onPress={() => void drop(item.place!)} /> : null}
              </View>
            }
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingRight: 16, paddingBottom: 8 },
  answer: { paddingHorizontal: 16, gap: 4 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
  trail: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  avatar: { width: 40, height: 40, borderRadius: 20, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
});
