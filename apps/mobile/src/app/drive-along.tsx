import { TipBanner } from '../ui/shell/TipBanner';
import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { driveAlongScreenState, groupRows, roughEtaMs, type GroupDest } from '@crewmap/shared/companions';
import { t } from '@crewmap/shared/i18n';
import { formatClock, formatMinutes } from '@crewmap/shared/units';
import { engine } from '../core/engine';
import { useCompanionLive, useDriveAlong } from '../core/companions';
import { useApp } from '../core/store';
import { Button, Card, Icon, Row, ScreenHeader, SectionLabel, Toggle } from '../ui/kit';
import { useLayoutMode, pageX } from '../ui/layout';
import { type, useTheme } from '../ui/theme';

/**
 * Drive together (D33): incoming invites, the active drive (members with ETA / arrived, host controls) and the
 * host's picker: destination (chosen through search / route preview), then any number of crewmates.
 */
export default function DriveAlongScreen() {
  const router = useRouter();
  const th = useTheme();
  const lay = useLayoutMode();
  const p = useLocalSearchParams<{ crew?: string; name?: string; lat?: string; lng?: string; with?: string }>();
  const session = useDriveAlong((s) => s.session);
  const invites = useDriveAlong((s) => s.invites);
  const live = useCompanionLive((s) => s.live);
  const friends = useApp((s) => s.allFriends);
  const crews = useApp((s) => s.crews);
  const fix = useApp((s) => s.fix);
  const navEta = useApp((s) => s.nav?.progress?.eta ?? null);
  const meId = engine.me.deviceId;
  const dest: GroupDest | null =
    p.lat && p.lng && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) ? { name: p.name ?? '', lat: Number(p.lat), lng: Number(p.lng) } : (session?.dest ?? null);
  const [picked, setPicked] = useState<Record<string, true>>(() => {
    const ids = new Set<string>((p.with ?? '').split(',').filter(Boolean));
    const c = crews.find((x) => x.id === p.crew);
    if (c) for (const id of c.memberIds) ids.add(id);
    ids.delete(meId);
    for (const id of [...ids]) if (engine.companions.groupAvailability(id) !== 'ok') ids.delete(id);
    return Object.fromEntries([...ids].map((id) => [id, true as const]));
  });
  const [sending, setSending] = useState(false);
  const ui = driveAlongScreenState(session, meId, Object.keys(picked).length, !!dest, sending);
  const list = useMemo(() => Object.values(friends).sort((a, b) => a.profile.name.localeCompare(b.profile.name)), [friends]);
  const why = (id: string) => {
    const a = engine.companions.groupAvailability(id);
    return a === 'ok' ? undefined : a === 'old' ? t('da.old') : a === 'policy' ? t('gd.sharingOff') : t('da.stale');
  };
  // Crewmates already in or invited to this drive are not offered again.
  const inSession = (id: string) => session?.members[id]?.state === 'joined' || session?.members[id]?.state === 'invited';
  const chooseDest = () => router.push({ pathname: '/search', params: { with: Object.keys(picked).join(',') } });
  const send = async () => {
    if (!dest || sending) return;
    setSending(true);
    await engine.companions.startDriveAlong(Object.keys(picked), p.crew ?? null, dest);
    setSending(false);
    // Stay here: the member list shows Invited / Joined / Declined and every option stays editable.
    setPicked({});
  };
  const rows = session?.dest
    ? groupRows(session, meId, fix ? { lat: fix.lat, lng: fix.lng, eta: navEta } : null, Object.fromEntries(Object.entries(live).map(([k, c]) => [k, { lat: c.lat, lng: c.lng, eta: c.eta }])), Date.now())
    : null;
  const statusText = (r: { status: string; etaAt: number | null; arrivedAt: number | null }) =>
    r.status === 'arrived' && r.arrivedAt ? `${t('gd.arrived')} ${formatClock(r.arrivedAt)}` : r.status === 'driving' ? (r.etaAt ? formatClock(r.etaAt) : t('da.joined')) : r.status === 'invited' ? t('da.invited') : r.status === 'declined' ? t('da.declined') : t('da.left');

  return (
    <ScrollView style={{ flex: 1, backgroundColor: th.bg }} contentContainerStyle={[{ paddingVertical: 28, gap: 14 }, pageX(lay)]}>
      <ScreenHeader testID="da-back" title={t('gd.title')} />
      <TipBanner screen="drive-along" />

      {invites.map((i) => (
        <Card key={i.from} style={{ gap: 10 }}>
          <Text style={[type.headline, { color: th.text }]}>{i.op.dest ? t('gd.invite', { name: i.op.ownerName, dest: i.op.dest.name }) : t('da.invite', { name: i.op.ownerName })}</Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button testID="da-accept" compact label={t('gd.join')} onPress={() => void engine.companions.accept(i.from)} />
            <Button testID="da-ignore" compact kind="ghost" label={t('da.ignore')} onPress={() => engine.companions.ignore(i.from)} />
            <Button testID="da-decline" compact kind="secondary" label={t('da.decline')} onPress={() => void engine.companions.decline(i.from)} />
          </View>
        </Card>
      ))}

      {session && (
        <>
          <SectionLabel>{session.dest ? t('gd.drivingTo', { dest: session.dest.name }) : t('da.active')}</SectionLabel>
          <Card style={{ paddingVertical: 0 }}>
            {rows
              ? rows.map((r) => <Row key={r.id} label={r.id === meId ? t('gd.you') : r.name} value={statusText(r)} />)
              : Object.entries(session.members)
                  .filter(([id]) => id !== meId)
                  .map(([id, m]) => <Row key={id} label={m.name} value={t(`da.${m.state}`)} />)}
            {ui.shareRoute && <Toggle testID="da-share-route" label={t('da.shareRoute')} value={session.shareRoute} onChange={(v) => engine.companions.setShareRoute(v)} />}
          </Card>
          {ui.changeDest && (
            <Button testID="gd-change-dest" kind="secondary" icon="pin" label={t('gd.changeDest')} onPress={() => router.push('/search')} />
          )}
          {ui.leave && (
            <Button testID="gd-leave" kind="ghost" label={t('da.leave')} onPress={() => void engine.companions.leaveDriveAlong()} />
          )}
          <Button testID="da-stop" kind="danger" label={ui.stop === 'end' ? t('gd.end') : t('da.leave')} onPress={() => void engine.companions.stopDriveAlong()} />
        </>
      )}

      {ui.host && (
        <>
          <SectionLabel>{t('gd.destination')}</SectionLabel>
          <Card style={{ paddingVertical: 0 }}>
            <Row testID="gd-dest" label={dest?.name || t('gd.chooseDest')} value={dest ? t('gd.change') : undefined} onPress={chooseDest} />
          </Card>
          <SectionLabel>{session ? t('gd.addMore') : t('da.friends')}</SectionLabel>
          <Card style={{ paddingVertical: 0 }}>
            {list
              .filter((f) => f.profile.deviceId !== meId && !inSession(f.profile.deviceId))
              .map((f) => {
                const id = f.profile.deviceId;
                const reason = why(id);
                const pos = live[id] ?? f.presence;
                const eta = dest && pos && Number.isFinite(pos.lat) ? formatMinutes(roughEtaMs(pos, dest) / 1000) : undefined;
                const on = !!picked[id];
                return reason ? (
                  <Row key={id} label={f.profile.name} value={reason} />
                ) : (
                  <Row
                    key={id}
                    testID={`da-pick-${f.profile.name}`}
                    label={f.profile.name}
                    value={eta}
                    right={<Icon name={on ? 'check' : 'plus'} size={20} color={on ? th.accent : th.textSoft} />}
                    onPress={() =>
                      setPicked((cur) => {
                        const { [id]: _drop, ...rest } = cur;
                        return on ? rest : { ...rest, [id]: true };
                      })
                    }
                  />
                );
              })}
          </Card>
          <Button testID="da-start" label={t('gd.send')} icon="users" disabled={!ui.canSend && !sending} loading={sending} onPress={() => void send()} />
        </>
      )}
    </ScrollView>
  );
}
