import { memo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { destinationCards, incomingPrompts, type AskEntry } from '@crewmap/shared/companions';
import { t } from '@crewmap/shared/i18n';
import { useAsks } from '../../core/asksStore';
import { useDriveAlong } from '../../core/companions';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { Bouncy, Button, Icon } from '../kit';
import { useLayoutMode } from '../layout';
import { elevation, font, radius, type, useTheme } from '../theme';
import { useFriendContext } from './DriveHud';
import { noticePolicy } from './driveUx';

/**
 * One location-ask prompt or answer (D47), as a card (browsing) or a one-line pill (driving: never a modal).
 * - Incoming "where do you want me?": choose a place (search screen in answer mode) / Here / Decline.
 * - Incoming "share once?": Share 15 min / Share 1 h / Decline (and mute).
 * - Answer to my ask: "<Name> wants you at <place>" -> Navigate / Drive together / Dismiss.
 */
export const AskCard = memo(function AskCard({ entry, pill }: { entry: AskEntry; pill: boolean }) {
  const th = useTheme();
  const router = useRouter();
  const name = useApp((s) => s.allFriends[entry.peer]?.profile.name ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const incoming = entry.dir === 'in';
  const place = entry.place;
  const title = incoming
    ? t(entry.ask === 'once' ? 'ask.promptOnce' : 'ask.promptWhere', { name })
    : t('ask.wantsYou', { name, place: place?.name ?? '' });

  const here = async () => {
    const st = useApp.getState();
    if (!st.fix) return setErr(t('ask.noFix'));
    setBusy(true);
    const ok = await engine.asks.answerWhere(entry.id, { name: t('ask.hereName', { name: st.me?.name ?? '' }), lat: st.fix.lat, lng: st.fix.lng });
    setBusy(false);
    if (!ok) setErr(t('friend.etaFailed'));
  };
  const share = async (min: number) => {
    setBusy(true);
    const r = await engine.asks.shareOnce(entry.id, min);
    setBusy(false);
    if (r === 'noFix') setErr(t('ask.noFix'));
    else if (r === 'failed') setErr(t('friend.etaFailed'));
  };
  const route = (withPeer: boolean) => {
    if (!place) return;
    engine.asks.dismiss(entry.id);
    router.push({ pathname: '/route', params: { name: place.name, lat: String(place.lat), lng: String(place.lng), ...(withPeer ? { with: entry.peer } : {}) } });
  };
  const together = !incoming && engine.companions.groupAvailability(entry.peer) === 'ok';

  if (pill)
    return (
      <View testID={`ask-pill-${entry.ask}`} style={[styles.pill, { backgroundColor: th.glass, borderColor: th.separator }, elevation.low]}>
        <Icon name={incoming ? 'locate' : 'pin'} size={18} color={th.accent} />
        <Text style={[type.caption, font('bold'), { color: th.text, flex: 1 }]} numberOfLines={1}>
          {title}
        </Text>
        <Bouncy
          testID="ask-pill-primary"
          accessibilityLabel={incoming ? t(entry.ask === 'once' ? 'ask.share15' : 'ask.here') : t('ask.navigate')}
          onPress={() => (incoming ? void (entry.ask === 'once' ? share(15) : here()) : route(false))}
          style={[styles.pillBtn, { backgroundColor: th.accent }]}
        >
          <Text style={[type.caption, font('bold'), { color: th.onAccent }]}>{incoming ? t(entry.ask === 'once' ? 'ask.share15' : 'ask.here') : t('ask.navigate')}</Text>
        </Bouncy>
        <Bouncy
          testID="ask-pill-dismiss"
          accessibilityLabel={incoming ? t('ask.decline') : t('ask.dismiss')}
          onPress={() => (incoming ? void engine.asks.decline(entry.id) : engine.asks.dismiss(entry.id))}
          hitSlop={{ top: 4, bottom: 4, left: 6, right: 6 }} style={styles.pillX}
        >
          <Icon name="close" size={16} color={th.textSoft} />
        </Bouncy>
      </View>
    );

  return (
    <View testID={`ask-card-${entry.ask}-${entry.dir}`} style={[styles.card, { backgroundColor: th.card, borderColor: th.separator }, elevation.high]}>
      <View style={styles.head}>
        <Icon name={incoming ? 'locate' : 'pin'} size={20} color={th.accent} />
        <Text style={[type.headline, { color: th.text, flex: 1 }]} numberOfLines={3}>
          {title}
        </Text>
      </View>
      {!incoming && !!entry.note && <Text style={[type.small, { color: th.textSoft }]}>{entry.note}</Text>}
      {!!err && <Text style={[type.small, { color: th.danger }]}>{err}</Text>}
      <View style={styles.actions}>
        {incoming && entry.ask === 'where' && (
          <>
            <Button testID="ask-choose" compact label={t('ask.choose')} onPress={() => router.push({ pathname: '/search', params: { answer: entry.id } })} />
            <Button testID="ask-here" compact kind="secondary" label={t('ask.here')} loading={busy} onPress={() => void here()} />
          </>
        )}
        {incoming && entry.ask === 'once' && (
          <>
            <Button testID="ask-share-15" compact label={t('ask.share15')} loading={busy} onPress={() => void share(15)} />
            <Button testID="ask-share-60" compact kind="secondary" label={t('ask.share60')} loading={busy} onPress={() => void share(60)} />
          </>
        )}
        {incoming && <Button testID="ask-decline" compact kind="secondary" label={t('ask.decline')} onPress={() => void engine.asks.decline(entry.id)} />}
        {incoming && <Button testID="ask-decline-mute" compact kind="ghost" label={t('ask.declineMute')} onPress={() => void engine.asks.decline(entry.id, true)} />}
        {!incoming && <Button testID="ask-navigate" compact label={t('ask.navigate')} onPress={() => route(false)} />}
        {together && <Button testID="ask-drive-together" compact kind="secondary" label={t('gd.title')} onPress={() => route(true)} />}
        {!incoming && <Button testID="ask-dismiss" compact kind="ghost" label={t('ask.dismiss')} onPress={() => engine.asks.dismiss(entry.id)} />}
      </View>
    </View>
  );
});

/**
 * Home overlay: the oldest open ask prompt, else the newest answer card. Browsing = a card; driving = a pill (deferred
 * right before a turn), exactly like the group-drive prompts; it yields to those while one is showing. `top` = bottom
 * of the banner / search block.
 */
export const AskCards = memo(function AskCards({ top }: { top: number }) {
  const lay = useLayoutMode();
  const ctx = useFriendContext();
  const nextM = useApp((s) => s.nav?.progress?.next?.distanceM ?? null);
  const entries = useAsks((s) => s.entries);
  const groupBusy = useDriveAlong((s) => s.invites.length > 0 || !!s.session?.pendingDest || !!s.summary);
  const action = noticePolicy('ask', ctx, nextM);
  if (action === 'defer' || action === 'drop' || groupBusy) return null;
  const entry = incomingPrompts(entries)[0] ?? destinationCards(entries).slice(-1)[0];
  if (!entry) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: top + 8, left: lay.gutterL, right: lay.gutterR, maxWidth: lay.wide ? lay.panelW : undefined }]}>
      <AskCard entry={entry} pill={action === 'pill'} />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { position: 'absolute', zIndex: 19 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.l, padding: 14, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 6, paddingVertical: 6, borderRadius: 26, borderWidth: StyleSheet.hairlineWidth },
  pillBtn: { minHeight: 36, paddingHorizontal: 14, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pillX: { width: 32, height: 36, alignItems: 'center', justifyContent: 'center' },
});
