import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { TipBanner } from '../shell/TipBanner';
import { QUIP_LIMITS, type SavedQuip } from '@crewmap/p2p';
import { EMOTE_LIMITS } from '@crewmap/shared/emotes';
import { t } from '@crewmap/shared/i18n';
import { platform } from '@crewmap/platform';
import { engine } from '../../core/engine';
import { blobUri, createQuip, deleteQuip, pickImage, renameQuip, saveReceived, useQuips, type PickedImage } from '../../core/quips';
import { useApp } from '../../core/store';
import { Button, Card, SectionLabel } from '../kit';
import { palette, font, type, useTheme } from '../theme';


/** "My quips": saved/created quips (play, send, rename, delete), quips received from friends (save), and the composer. */
export function QuipSection({ friendId, friendName, disabled }: { friendId: string; friendName: string; disabled: boolean }) {
  const th = useTheme();
  const saved = useQuips((s) => s.saved);
  const received = useQuips((s) => s.received);
  const me = useApp((s) => s.me?.name ?? '');
  const driving = useApp((s) => s.driving || s.nav?.active === true);
  const [composing, setComposing] = useState(false);
  const [cap, setCap] = useState('');
  const [emoji, setEmoji] = useState('');
  const [audio, setAudio] = useState<{ base64: string; ms: number } | null>(null);
  const [image, setImage] = useState<Extract<PickedImage, { ok: true }> | null>(null);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);

  const savedIds = new Set(saved.map((q) => q.id));
  const unsaved = driving ? [] : received.filter((r) => !savedIds.has(r.id));
  const canCreate = !!(cap.trim() || emoji.trim() || audio || image);

  const [leftMs, setLeftMs] = useState<number>(EMOTE_LIMITS.maxClipMs);
  const holdRecord = async () => {
    setRecording(true);
    setLeftMs(EMOTE_LIMITS.maxClipMs);
    let tick: ReturnType<typeof setInterval> | null = null;
    try {
      const c = await engine.emotes.recordClip(() => {
        const t0 = Date.now();
        tick = setInterval(() => setLeftMs(Math.max(0, EMOTE_LIMITS.maxClipMs - (Date.now() - t0))), 100);
      });
      if (c) setAudio({ base64: c.clip, ms: c.clipMs });
    } finally {
      if (tick) clearInterval(tick);
      setRecording(false);
    }
  };
  const pick = async () => {
    const r = await pickImage();
    if (r.ok) {
      setImage(r);
      setNote(null);
    } else if (r.reason !== 'canceled') setNote(t('quip.imageTooBig'));
  };
  const create = async () => {
    const q = await createQuip({
      by: me,
      cap,
      emoji,
      ...(audio ? { audio } : {}),
      ...(image ? { image: { bytes: image.bytes, mime: image.mime } } : {}),
    });
    if (!q) return setNote(t('quip.failed'));
    setCap('');
    setEmoji('');
    setAudio(null);
    setImage(null);
    setComposing(false);
    setNote(null);
  };
  const send = async (to: string, q: SavedQuip) => {
    const r = await engine.emotes.sendQuip(to, q);
    setNote(r === 'slow' ? t('quip.slow') : r === 'failed' ? t('quip.failed') : null);
  };
  const play = async (q: SavedQuip) => {
    const uri = q.a ? await blobUri(q.a, true) : null;
    if (uri) await platform.audio.playClip(uri, { duckUnderVoice: false });
  };

  const input = [styles.input, { color: th.text, borderColor: th.border, backgroundColor: th.card }];
  return (
    <View testID="quips" style={{ gap: 10 }}>
      <TipBanner screen="quips" />
      <SectionLabel>{t('quip.mine')}</SectionLabel>
      {unsaved.map((r) => (
        <Card key={r.id} style={styles.row}>
          <Text style={styles.emoji}>{r.meta.emoji ?? '\u{1F399}️'}</Text>
          <Text style={[type.body, { color: th.text, flex: 1 }]} numberOfLines={1}>
            {`${r.meta.cap ?? t('emote.custom')} · ${t('quip.by', { name: r.meta.by })}`}
          </Text>
          <Button kind="secondary" compact testID="quip-save-received" label={t('quip.save')} onPress={() => void saveReceived(r.meta)} />
        </Card>
      ))}
      {saved.map((q) => (
        <Card key={q.id} style={{ gap: 8 }}>
          <View style={styles.rowInner}>
            {q.i ? <ThumbOf hash={q.i} /> : <Text style={styles.emoji}>{q.emoji ?? '\u{1F399}️'}</Text>}
            {renaming?.id === q.id ? (
              <TextInput
                style={[...input, { flex: 1 }]}
                value={renaming.text}
                maxLength={QUIP_LIMITS.maxCaption}
                autoFocus
                onChangeText={(text) => setRenaming({ id: q.id, text })}
                onSubmitEditing={() => void renameQuip(q.id, renaming.text).then(() => setRenaming(null))}
              />
            ) : (
              <View style={{ flex: 1 }}>
                <Text style={[type.body, font('bold'), { color: th.text }]} numberOfLines={1}>
                  {q.cap ?? t('emote.custom')}
                </Text>
                {!q.mine && <Text style={[type.caption, { color: th.textSoft }]}>{t('quip.by', { name: q.by })}</Text>}
              </View>
            )}
          </View>
          <View style={styles.actions}>
            {q.a && <Button kind="ghost" compact label={t('quip.play')} onPress={() => void play(q)} />}
            <Button kind="primary" compact testID="quip-send" disabled={disabled} label={t('quip.toFriend', { name: friendName })} onPress={() => void send(friendId, q)} />
            <Button kind="secondary" compact testID="quip-send-crew" label={t('quip.toCrew')} onPress={() => void send('crew', q)} />
            <Button kind="ghost" compact label={t('quip.rename')} onPress={() => setRenaming({ id: q.id, text: q.cap ?? '' })} />
            <Button kind="danger" compact label={t('quip.delete')} onPress={() => void deleteQuip(q.id)} />
          </View>
        </Card>
      ))}
      {note && <Text style={[type.caption, { color: palette.danger }]}>{note}</Text>}
      {composing ? (
        <Card style={{ gap: 10 }}>
          <TextInput testID="quip-caption" style={input} value={cap} maxLength={QUIP_LIMITS.maxCaption} placeholder={t('quip.caption')} placeholderTextColor={th.textSoft} onChangeText={setCap} />
          <TextInput testID="quip-emoji" style={input} value={emoji} maxLength={8} placeholder={t('quip.emoji')} placeholderTextColor={th.textSoft} onChangeText={setEmoji} />
          <View style={styles.actions}>
            <Button kind="secondary" compact testID="quip-image" label={image ? `${t('quip.image')} ✓` : t('quip.image')} onPress={() => void pick()} />
            <Pressable
              testID="quip-record"
              accessibilityRole="button"
              accessibilityLabel={t('quip.noVoice')}
              onPressIn={() => void holdRecord()}
              onPressOut={() => void engine.emotes.stopRecording()}
              style={[styles.rec, { backgroundColor: recording ? palette.danger : th.card, borderColor: recording ? palette.danger : th.border }]}
            >
              <Text style={[type.body, font('bold'), { color: recording ? '#FFFFFF' : th.text }]}>
                {recording ? `${(leftMs / 1000).toFixed(1)} s` : audio ? `\u{1F399}️ ${(audio.ms / 1000).toFixed(1)} s` : t('quip.noVoice')}
              </Text>
            </Pressable>
          </View>
          <Button testID="quip-create" label={t('quip.create')} disabled={!canCreate} onPress={() => void create()} />
        </Card>
      ) : (
        <Button kind="secondary" testID="quip-new" label={t('quip.new')} onPress={() => setComposing(true)} />
      )}
    </View>
  );
}

function ThumbOf({ hash }: { hash: { h: string } }) {
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null) {
    void blobUri({ h: hash.h, n: 0, mime: '' }, false).then((u) => setUri(u ?? ''));
    return <View style={styles.thumb} />;
  }
  return uri ? <Image source={{ uri }} style={styles.thumb} contentFit="cover" /> : <View style={styles.thumb} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  emoji: { fontSize: 28, lineHeight: 34 },
  thumb: { width: 40, height: 40, borderRadius: 8 },
  input: { borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 12, minHeight: 44, fontSize: 15 },
  rec: { flex: 1, minHeight: 40, borderRadius: 14, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
});
