import { useEffect, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { formatJoinCode, normaliseJoinCode } from '@crewmap/p2p';
import { t } from '@crewmap/shared/i18n';
import { loadClipboard } from '../core/clipboardInvite';
import { engine } from '../core/engine';
import { inviteErrorMessage } from '../core/inviteErrors';
import { Button, Card, Field } from './kit';
import { useNow } from './friend/useNow';
import { font, type, useTheme } from './theme';

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Admin: a live short code with its countdown, copy and share (D34). */
export function JoinCodeCard({ code, expiresAt, crewName, onExpired }: { code: string; expiresAt: number; crewName: string; onExpired: () => void }) {
  const th = useTheme();
  const now = useNow(1_000);
  const [copied, setCopied] = useState(false);
  const left = expiresAt - now;
  useEffect(() => {
    if (left <= 0) onExpired();
  }, [left <= 0]);
  const shown = formatJoinCode(code);
  return (
    <Card style={{ alignItems: 'center', gap: 12, paddingVertical: 20 }}>
      <Text testID="invite-code" selectable style={[type.title, font('bold'), styles.code, { color: th.text }]}>
        {shown}
      </Text>
      <Text style={[type.caption, { color: th.textSoft }]}>{t('code.left', { time: mmss(left) })}</Text>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Button
            kind="secondary"
            label={copied ? t('code.copied') : t('code.copy')}
            onPress={async () => {
              const clip = await loadClipboard();
              if (!clip) return;
              await clip.setStringAsync(code);
              setCopied(true);
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button icon="share" label={t('circle.share')} onPress={() => void Share.share({ message: t('code.shareMessage', { name: crewName, code: shown }) })} />
        </View>
      </View>
    </Card>
  );
}

/** Joiner: type or paste a short code; resolves it to an invite link and hands it to the normal link join. */
export function JoinCodeField({ onLink, disabled, before }: { onLink: (link: string) => void; disabled?: boolean; before?: () => Promise<void> }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const th = useTheme();
  const valid = normaliseJoinCode(value) !== null;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await before?.();
      const link = await engine.crews.resolveCode(value);
      setValue('');
      onLink(link);
    } catch (e) {
      setError(inviteErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Field
            testID="join-code-field"
            label={t('code.join')}
            hideLabel
            placeholder="ABC 234"
            icon="lock"
            value={value}
            maxLength={12}
            autoCapitalize="characters"
            autoCorrect={false}
            onChangeText={(v) => {
              setError(null);
              setValue(v.toUpperCase());
            }}
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
          />
        </View>
        <Button testID="join-code-submit" label={t('onb.next')} loading={busy} disabled={disabled || busy || !valid} onPress={() => void submit()} />
      </View>
      {error && <Text style={[type.caption, { color: th.danger }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  code: { letterSpacing: 4, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', alignSelf: 'stretch' },
});
