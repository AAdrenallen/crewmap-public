import { useEffect, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { formatAge } from '@crewmap/shared/units';
import { t } from '@crewmap/shared/i18n';
import { extractInviteLink, toShareLink } from '@crewmap/shared/links';
import type { AvatarConfig } from '@crewmap/shared/avatar';
import { engine } from '../core/engine';
import { useApp } from '../core/store';
import { Badge, BatteryIcon, Button, Card, Chip, EmptyState, Field, KeyboardScroll, ListItem, PresenceDot, presenceState, ScreenHeader, SectionLabel, Toast } from '../ui/kit';
import { pageX, useLayoutMode } from '../ui/layout';
import { ListRow } from '../ui/screens-common/Layout';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { JoinCodeCard, JoinCodeField } from '../ui/JoinCode';
import { CheckInOptIn, useCheckInChoice } from '../ui/safety/CheckInOptIn';
import { inviteErrorMessage } from '../core/inviteErrors';
import { AvatarStill } from '../ui/map/Sprites';
import { useNow } from '../ui/friend/useNow';
import { Skeleton } from '../ui/screens-common/Skeleton';
import { type, useTheme } from '../ui/theme';

function Avatar({ avatar, state }: { avatar: AvatarConfig; state: 'live' | 'stale' | 'off' | null }) {
  const th = useTheme();
  return (
    <View>
      <View style={[styles.avatar, { backgroundColor: th.cardAlt }]}>
        <AvatarStill avatar={avatar} size={44} />
      </View>
      {state && (
        <View style={styles.dot}>
          <PresenceDot state={state} ring={th.card} />
        </View>
      )}
    </View>
  );
}

export default function Crew() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const lay = useLayoutMode();
  const crews = useApp((s) => s.crews);
  const focus = useApp((s) => s.circle);
  const friends = useApp((s) => s.allFriends);
  const me = useApp((s) => s.me);
  const chatUnread = useApp((s) => s.chatUnread);
  const ready = useApp((s) => s.ready);
  const now = useNow(30_000);
  const [selId, setSel] = useState<string | null>(focus?.id ?? null);
  const circle = crews.find((c) => c.id === selId) ?? crews[0] ?? null;
  const [invite, setInvite] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; message?: string; label: string; run: () => void } | null>(null);
  const [edit, setEdit] = useState<'new' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const [undo, setUndo] = useState<{ id: string; prev: string; name: string } | null>(null);
  const isAdmin = circle?.isAdmin ?? false;
  const members = Object.values(friends).filter((f) => !!circle && f.crews.includes(circle.id));
  useEffect(() => {
    setInvite(null);
    setCode(null);
    setCodeError(null);
  }, [circle?.id]);
  useEffect(() => {
    if (!undo) return;
    const id = setTimeout(() => setUndo(null), 6_000);
    return () => clearTimeout(id);
  }, [undo]);

  const makeInvite = async () => {
    if (!circle) return;
    setBusy(true);
    try {
      setInvite((await engine.crews.manager(circle.id)!.invite()).link);
    } finally {
      setBusy(false);
    }
  };

  const makeCode = async () => {
    if (!circle) return;
    setBusy(true);
    setCodeError(null);
    try {
      setCode(await engine.crews.manager(circle.id)!.codeInvite());
    } catch (e) {
      setCodeError(inviteErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submitName = async () => {
    const n = name.trim();
    if (!n || !me) return;
    setBusy(true);
    try {
      if (edit === 'new') setSel(await engine.crews.create(n, me.name, { checkIn: useCheckInChoice.getState().on }));
      else if (circle) {
        const prev = circle.name;
        await engine.crews.rename(circle.id, n);
        if (prev !== n) setUndo({ id: circle.id, prev, name: n });
      }
      setEdit(null);
      setName('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
    <KeyboardScroll style={{ backgroundColor: th.bg }} contentContainerStyle={{ ...pageX(lay), paddingTop: insets.top + 8, gap: 12, paddingBottom: insets.bottom + 30 }}>
      <ScreenHeader title={circle?.name ?? t('circle.title')} />
      <View style={styles.chips}>
        {crews.map((c) => (
          <Chip key={c.id} testID={'crew-' + c.name} label={`${c.name} · ${c.memberIds.length}`} active={c.id === circle?.id} onPress={() => setSel(c.id)} />
        ))}
        <Chip testID="crew-new" icon="plus" label={t('crew.new')} active={edit === 'new'} onPress={() => setEdit(edit === 'new' ? null : 'new')} />
      </View>
      {edit && (
        <Card style={{ gap: 12 }}>
          <Field testID="crew-name" label={edit === 'new' ? t('onb.crewName') : t('crew.rename')} value={name} onChangeText={setName} autoFocus />
          {edit === 'new' && <CheckInOptIn />}
          <Button testID="crew-name-save" loading={busy} disabled={!name.trim()} label={edit === 'new' ? t('crew.create') : t('common.save')} onPress={() => void submitName()} />
        </Card>
      )}
      <SectionLabel>{`${t('crew.members')} · ${t('crew.membersN', { n: members.length + (me ? 1 : 0) })}`}</SectionLabel>
      <Card style={{ paddingVertical: 4 }}>
        {me && (
          <ListItem
            title={me.name}
            subtitle={t('circle.you')}
            leading={<Avatar avatar={me.avatar} state={null} />}
            testID="member-me"
            onPress={() => router.push('/avatar')}
            trailing={circle?.ownerId === me.deviceId ? <Badge tone="sun" label={t('circle.owner')} /> : undefined}
          />
        )}
        {!ready && members.length === 0 && (
          <View style={{ gap: 12, padding: 12 }}>
            <Skeleton height={44} />
            <Skeleton height={44} />
          </View>
        )}
        {ready && members.length === 0 && <EmptyState icon="crew" title={t('circle.empty')} />}
        {members.map((f) => {
          const p = f.presence;
          return (
            <ListItem
              key={f.profile.deviceId}
              testID={`member-${f.profile.name}`}
              title={f.profile.name}
              onPress={() => router.push({ pathname: '/friend/[id]', params: { id: f.profile.deviceId } })}
              leading={<Avatar avatar={f.profile.avatar} state={presenceState(f)} />}
              subtitle={
                f.paused ? (
                  t('map.paused')
                ) : p ? (
                  <Text>
                    {t(`act.${p.act}`)} · {t('crew.seen', { age: formatAge(p.t, now) })}
                  </Text>
                ) : (
                  t('crew.neverSeen')
                )
              }
              trailing={
                <View style={styles.trail}>
                  {p && p.bat !== null && !f.paused && (
                    <View style={styles.bat}>
                      <BatteryIcon pct={p.bat} charging={p.chg} size={12} color={th.textSoft} />
                      <Text style={[type.caption, { color: th.textSoft }]}>{t('map.battery', { pct: p.bat })}</Text>
                    </View>
                  )}
                  {f.isOwner && <Badge tone="sun" label={t('circle.owner')} />}
                  {isAdmin && !f.isOwner && (
                    <Chip
                      testID={`remove-${f.profile.name}`}
                      label={t('circle.remove')}
                      onPress={() =>
                        setConfirm({ title: f.profile.name, label: t('circle.remove'), run: () => void engine.crews.manager(circle!.id)?.remove(f.profile.deviceId) })
                      }
                    />
                  )}
                </View>
              }
            />
          );
        })}
      </Card>
      {isAdmin && (
        <>
          {invite ? (
            <Card style={{ alignItems: 'center', gap: 16, paddingVertical: 24 }}>
              <View style={styles.qr} testID="invite-qr">
                {/* https form: a system camera without the app lands on the install page; the in-app scanner reads both. */}
                <QRCode value={toShareLink(invite)} size={220} color="#0B0F1A" backgroundColor="#FFFFFF" />
              </View>
              <View style={styles.inviteRow}>
                <View style={{ flex: 1 }}>
                  <Button testID="invite-share" icon="share" label={t('circle.share')} onPress={() => void Share.share({ message: t('circle.shareMessage', { name: circle?.name ?? '', link: toShareLink(invite) }) })} />
                </View>
                <Button testID="invite-code-create" kind="secondary" icon="lock" label={t('code.button')} loading={busy} onPress={() => void makeCode()} />
              </View>
            </Card>
          ) : (
            <View style={styles.inviteRow}>
              <View style={{ flex: 1 }}>
                <Button testID="invite-create" icon="plus" loading={busy} label={t('circle.invite')} onPress={() => void makeInvite()} />
              </View>
              <Button testID="invite-code-create" kind="secondary" icon="lock" label={t('code.button')} loading={busy} onPress={() => void makeCode()} />
            </View>
          )}
          {code && <JoinCodeCard code={code.code} expiresAt={code.expiresAt} crewName={circle?.name ?? ''} onExpired={() => setCode(null)} />}
          {codeError && <Text style={[type.caption, { color: th.danger }]}>{codeError}</Text>}
        </>
      )}
      <Button kind="secondary" icon="qr" label={t('circle.scan')} onPress={() => router.push('/scan')} />
      <Button testID="invite-paste" kind="secondary" icon="link" label={t('circle.paste')} onPress={() => setPasteOpen((o) => !o)} />
      {pasteOpen && (
        <Field
          testID="invite-paste-field"
          label={t('circle.paste')}
          hideLabel
          placeholder="crewmap://join#…"
          icon="link"
          value={pasted}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(v) => {
            setPasted(v);
            const l = extractInviteLink(v);
            if (l) {
              setPasted('');
              setPasteOpen(false);
              router.push({ pathname: '/join', params: { link: l } });
            }
          }}
        />
      )}
      <Button testID="join-code-open" kind="secondary" icon="lock" label={t('code.join')} onPress={() => setCodeOpen((o) => !o)} />
      {codeOpen && (
        <JoinCodeField
          onLink={(l) => {
            setCodeOpen(false);
            router.push({ pathname: '/join', params: { link: l } });
          }}
        />
      )}
      {circle && (
        <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
          <ListRow testID="open-chat" icon="users" label={t('chat.crew')} value={chatUnread[`crew:${circle.id}`] ? String(chatUnread[`crew:${circle.id}`]) : undefined} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: `crew:${circle.id}` } })} />
          <ListRow testID="crew-drive-along" icon="car" label={t('da.title')} onPress={() => router.push({ pathname: '/drive-along', params: { crew: circle.id } })} />
          <ListRow testID="crew-sees" icon="eye" label={t('crew.sees')} onPress={() => router.push({ pathname: '/crew-sharing/[id]', params: { id: circle.id } })} />
          {isAdmin && <ListRow testID="crew-rename" icon="feather" label={t('crew.rename')} onPress={() => { setName(circle.name); setEdit('rename'); }} />}
          <ListRow
            testID="crew-leave"
            icon="trash"
            danger
            last
            label={t('crew.leave')}
            onPress={() =>
              setConfirm({ title: t('crew.leave'), message: t('crew.leaveConfirm', { name: circle.name }), label: t('crew.leave'), run: () => void engine.crews.leave(circle.id).then(() => setSel(null)) })
            }
          />
        </Card>
      )}
    </KeyboardScroll>
      <ConfirmSheet
        visible={!!confirm}
        title={confirm?.title ?? ''}
        message={confirm?.message}
        confirmLabel={confirm?.label ?? ''}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          c?.run();
        }}
      />
      {undo && (
        <Toast
          testID="crew-rename-undo"
          message={`${t('crew.renamed', { name: undo.name })} · ${t('common.undo')}`}
          style={{ position: 'absolute', left: lay.gutterL + 16, right: lay.gutterR + 16, bottom: insets.bottom + 20 }}
          onPress={() => {
            void engine.crews.rename(undo.id, undo.prev);
            setUndo(null);
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 48, height: 48, borderRadius: 24, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', right: -1, bottom: -1 },
  trail: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  qr: { backgroundColor: '#FFFFFF', padding: 16, borderRadius: 20 },
  inviteRow: { flexDirection: 'row', gap: 10, alignSelf: 'stretch' },
});
