import { memo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { arrivalGaps, convoyLeader, roughEtaMs, type GroupDest } from '@crewmap/shared/companions';
import { t } from '@crewmap/shared/i18n';
import { formatClock, formatMinutes } from '@crewmap/shared/units';
import { engine } from '../../core/engine';
import { useDriveAlong } from '../../core/companions';
import { useApp } from '../../core/store';
import { Bouncy, Button, Icon } from '../kit';
import { useLayoutMode } from '../layout';
import { elevation, font, radius, type, useTheme } from '../theme';
import { useFriendContext } from './DriveHud';
import { noticePolicy } from './driveUx';

/** My rough ETA to a group destination, before any route exists (never starts a preview: that would replace my nav). */
function etaText(dest: GroupDest | undefined): string {
  const fix = useApp.getState().fix;
  return dest && fix ? t('gd.etaFrom', { time: formatClock(Date.now() + roughEtaMs(fix, dest)) }) : '';
}

/**
 * Group drive prompts (D46), all non-blocking. Browsing: a card (host, destination, my ETA, Join / Decline). Driving:
 * a pill with one-tap Join (deferred right before a turn). Also: the host moved the destination (Go / Keep), and the
 * end-of-drive summary. `top` = bottom of the banner / search block.
 */
export const GroupDriveCards = memo(function GroupDriveCards({ top }: { top: number }) {
  const th = useTheme();
  const lay = useLayoutMode();
  const router = useRouter();
  const ctx = useFriendContext();
  const nextM = useApp((s) => s.nav?.progress?.next?.distanceM ?? null);
  const invite = useDriveAlong((s) => s.invites[0] ?? null);
  const pending = useDriveAlong((s) => s.session?.pendingDest ?? null);
  const hostName = useDriveAlong((s) => (s.session ? (s.session.members[s.session.owner]?.name ?? '') : ''));
  const summary = useDriveAlong((s) => s.summary);
  // Convoy (D65): the leader shared a route I have not adopted or dismissed yet.
  const followName = useDriveAlong((s) => {
    const leader = s.session ? convoyLeader(s.session) : null;
    if (!leader || leader === engine.me.deviceId || s.followDone === leader || !s.routes[leader]) return null;
    return s.session!.members[leader]?.name ?? null;
  });
  const [busy, setBusy] = useState(false);
  const action = noticePolicy('groupDrive', ctx, nextM);
  const pill = action === 'pill';
  const place = [styles.wrap, { top: top + 8, left: lay.gutterL, right: lay.gutterR, maxWidth: lay.wide ? lay.panelW : undefined }];

  /** Navigation failed to start (offline / no route): fall back to the route screen so the user can retry. */
  const routeFallback = (dest: GroupDest) =>
    router.push({ pathname: '/route', params: { name: dest.name, lat: String(dest.lat), lng: String(dest.lng) } });

  const join = async () => {
    if (!invite || busy) return;
    setBusy(true);
    const dest = invite.op.dest;
    const ok = await engine.companions.accept(invite.from);
    setBusy(false);
    if (!ok && dest) routeFallback(dest);
  };
  const go = async () => {
    const dest = pending?.dest;
    if (!dest || busy) return;
    setBusy(true);
    const ok = await engine.companions.acceptDest();
    setBusy(false);
    if (!ok) routeFallback(dest);
  };

  if (action === 'defer' || action === 'drop') return null;

  if (invite) {
    const dest = invite.op.dest;
    const title = dest ? t('gd.invite', { name: invite.op.ownerName, dest: dest.name }) : t('da.invite', { name: invite.op.ownerName });
    if (pill)
      return (
        <View pointerEvents="box-none" style={place}>
          <View style={[styles.pill, { backgroundColor: th.glass, borderColor: th.separator }, elevation.low]}>
            <Icon name="car" size={18} color={th.accent} />
            <Text style={[type.caption, font('bold'), { color: th.text, flex: 1 }]} numberOfLines={1}>
              {title}
            </Text>
            <Bouncy testID="gd-join-pill" accessibilityLabel={t('gd.join')} onPress={() => void join()} style={[styles.pillBtn, { backgroundColor: th.accent }]}>
              <Text style={[type.caption, font('bold'), { color: th.onAccent }]}>{t('gd.join')}</Text>
            </Bouncy>
            <Bouncy testID="gd-ignore-pill" accessibilityLabel={t('da.ignore')} onPress={() => engine.companions.ignore(invite.from)} hitSlop={{ top: 4, bottom: 4, left: 6, right: 6 }} style={styles.pillX}>
              <Icon name="close" size={16} color={th.textSoft} />
            </Bouncy>
          </View>
        </View>
      );
    return (
      <View pointerEvents="box-none" style={place}>
        <View testID="gd-invite" style={[styles.card, { backgroundColor: th.card, borderColor: th.separator }, elevation.high]}>
          <View style={styles.head}>
            <Icon name="car" size={20} color={th.accent} />
            <Text style={[type.headline, { color: th.text, flex: 1 }]} numberOfLines={2}>
              {title}
            </Text>
          </View>
          {!!dest && <Text style={[type.small, { color: th.textSoft }]}>{etaText(dest)}</Text>}
          <View style={styles.actions}>
            <Button testID="gd-join" compact label={t('gd.join')} loading={busy} onPress={() => void join()} />
            <Button testID="gd-decline" compact kind="secondary" label={t('da.decline')} onPress={() => void engine.companions.decline(invite.from)} />
            <Button testID="gd-ignore" compact kind="ghost" label={t('da.ignore')} onPress={() => engine.companions.ignore(invite.from)} />
          </View>
        </View>
      </View>
    );
  }

  if (pending) {
    const title = t('gd.destChanged', { name: hostName, dest: pending.dest.name });
    return (
      <View pointerEvents="box-none" style={place}>
        <View testID="gd-dest-prompt" style={[pill ? styles.pill : styles.card, { backgroundColor: pill ? th.glass : th.card, borderColor: th.separator }, pill ? elevation.low : elevation.high]}>
          <Icon name="pin" size={18} color={th.accent} />
          <Text style={[pill ? type.caption : type.headline, pill ? font('bold') : null, { color: th.text, flex: 1 }]} numberOfLines={2}>
            {title}
          </Text>
          <Button testID="gd-dest-go" compact label={t('gd.go')} loading={busy} onPress={() => void go()} />
          <Button testID="gd-dest-keep" compact kind="ghost" label={t('gd.keep')} onPress={() => engine.companions.dismissDest()} />
        </View>
      </View>
    );
  }

  if (followName) {
    const follow = async () => {
      if (busy) return;
      setBusy(true);
      await engine.companions.followLeader();
      setBusy(false);
    };
    return (
      <View pointerEvents="box-none" style={place}>
        <View testID="cv-follow" style={[pill ? styles.pill : styles.card, { backgroundColor: pill ? th.glass : th.card, borderColor: th.separator }, pill ? elevation.low : elevation.high, !pill && styles.head]}>
          <Icon name="route" size={18} color={th.accent} />
          <Text style={[pill ? type.caption : type.headline, pill ? font('bold') : null, { color: th.text, flex: 1 }]} numberOfLines={2}>
            {t('cv.follow', { name: followName })}
          </Text>
          <Button testID="cv-follow-go" compact label={t('cv.followShort')} loading={busy} onPress={() => void follow()} />
          <Bouncy testID="cv-follow-x" accessibilityLabel={t('common.close')} onPress={() => engine.companions.dismissFollow()} hitSlop={{ top: 4, bottom: 4, left: 6, right: 6 }} style={styles.pillX}>
            <Icon name="close" size={16} color={th.textSoft} />
          </Bouncy>
        </View>
      </View>
    );
  }

  if (summary) {
    return (
      <View pointerEvents="box-none" style={place}>
        <View testID="gd-summary" style={[styles.card, { backgroundColor: th.card, borderColor: th.separator }, elevation.high]}>
          <View style={styles.head}>
            <Icon name="check" size={20} color={th.accent} />
            <Text style={[type.headline, { color: th.text, flex: 1 }]} numberOfLines={2}>
              {t('gd.summary', { dest: summary.dest })}
            </Text>
          </View>
          {arrivalGaps(summary).map((a, i) => (
            <Text key={a.id} style={[type.small, { color: th.text }]}>
              {i + 1}. {a.name}  {formatClock(a.at)}
              {i > 0 && a.afterS >= 60 ? `  +${formatMinutes(a.afterS)}` : ''}
            </Text>
          ))}
          {summary.missing.length > 0 && (
            <Text style={[type.small, { color: th.textSoft }]}>{t('gd.missing', { names: summary.missing.map((m) => m.name).join(', ') })}</Text>
          )}
          <View style={styles.actions}>
            <Button testID="gd-summary-close" compact kind="secondary" label={t('common.close')} onPress={() => engine.companions.dismissSummary()} />
          </View>
        </View>
      </View>
    );
  }
  return null;
});

const styles = StyleSheet.create({
  wrap: { position: 'absolute', zIndex: 20 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.l, padding: 14, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 6, paddingVertical: 6, borderRadius: 26, borderWidth: StyleSheet.hairlineWidth },
  pillBtn: { minHeight: 36, paddingHorizontal: 14, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pillX: { width: 32, height: 36, alignItems: 'center', justifyContent: 'center' },
});
