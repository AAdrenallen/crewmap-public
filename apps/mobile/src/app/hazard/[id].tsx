import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { attribution, CONFIRMABLE, FRIEND_REPORT_TYPES, type MergedHazard } from '@crewmap/hazards';
import { haversineM } from '@crewmap/shared/geo';
import { lang, t } from '@crewmap/shared/i18n';
import { formatDistance } from '@crewmap/shared/units';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { useBackClose } from '../../ui/useBackClose';
import { Button, Card, EmptyState, H, Icon, T, Toast } from '../../ui/kit';
import { HAZARD_ICON } from '../../ui/map/hazardIcons';
import { hazardAgeText } from '../../ui/nav/age';
import { useTheme } from '../../ui/theme';

/** How long the vote confirmation (with Undo) stays before the sheet closes. */
const UNDO_MS = 4000;

/** Hazard detail: type, source attribution, age, distance, thumbs-up count, still there? votes, navigate, clear own report. */
export default function HazardSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const th = useTheme();
  const live = useApp((s) => s.hazards.find((x) => x.id === id));
  const fix = useApp((s) => s.fix);
  // A vote can drop the hazard from the list (down-voted away); keep showing it until the sheet closes.
  const last = useRef<MergedHazard | null>(null);
  if (live) last.current = live;
  const h = live ?? last.current;
  const [voted, setVoted] = useState<null | { up: boolean; undo: () => void }>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  useBackClose(close);

  if (!h) {
    return (
      <View style={[styles.root, { backgroundColor: th.bg }]}>
        <EmptyState testID="hazard-gone" icon="alert" title={t('hz.gone')} action={{ label: t('common.close'), onPress: close }} />
      </View>
    );
  }

  const votable = CONFIRMABLE.includes(h.type) || (FRIEND_REPORT_TYPES as readonly string[]).includes(h.type);
  const own = engine.hazards.isOwn(h.memberIds);
  const meta = [hazardAgeText(h, Date.now()), fix ? formatDistance(haversineM(fix, h), lang()) : null].filter(Boolean).join(' · ');

  const vote = (up: boolean) => {
    const undo = engine.hazards.vote(h.memberIds, up);
    setVoted({ up, undo });
    timer.current = setTimeout(close, UNDO_MS);
  };
  const undoVote = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    voted?.undo();
    setVoted(null);
  };
  const navigate = () => router.replace({ pathname: '/route', params: { name: t(`hz.${h.type}`), lat: String(h.lat), lng: String(h.lng) } });
  const clear = () => {
    engine.hazards.clear(h.memberIds);
    close();
  };

  return (
    <View style={[styles.root, { backgroundColor: th.bg }]}>
      <Card style={{ gap: 12 }}>
        <View style={styles.head}>
          <Image source={HAZARD_ICON[h.type]} style={{ width: 44, height: 55 }} resizeMode="contain" />
          <View style={{ flex: 1, gap: 2 }}>
            <H>{t(`hz.${h.type}`)}</H>
            {h.street ? <T numberOfLines={1}>{h.street}</T> : null}
            <T soft testID="hazard-attribution">{attribution(h)}</T>
            <View style={styles.metaRow}>
              <T soft>{meta}</T>
              {h.confirmations > 0 ? (
                <View style={styles.conf}>
                  <Icon name="thumbUp" size={14} color={th.textSoft} />
                  <T soft>{String(h.confirmations)}</T>
                </View>
              ) : null}
            </View>
          </View>
        </View>
        {h.description ? <T soft>{h.description}</T> : null}
        {votable && !own ? (
          <>
            <T style={{ fontWeight: '600' }}>{t('nav.stillThere')}</T>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Button testID="hazard-yes" icon="thumbUp" label={t('nav.yes')} disabled={!!voted} onPress={() => vote(true)} />
              </View>
              <View style={{ flex: 1 }}>
                <Button testID="hazard-no" kind="ghost" icon="thumbDown" label={t('nav.no')} disabled={!!voted} onPress={() => vote(false)} />
              </View>
            </View>
          </>
        ) : null}
        <Button testID="hazard-navigate" kind="secondary" icon="route" label={t('hz.navigate')} onPress={navigate} />
        {own ? <Button testID="hazard-clear" kind="ghost" icon="trash" label={t('hz.clear')} onPress={clear} /> : null}
      </Card>
      {voted ? <Toast testID="hazard-undo" style={styles.toast} icon="check" message={`${t('hz.voted')} · ${t('hz.undo')}`} onPress={undoVote} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  conf: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  toast: { position: 'absolute', alignSelf: 'center', bottom: 12 },
});
