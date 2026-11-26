import { useEffect, useRef, useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CHAT_MAX_CHARS, crewOfThread, peerSupports, type StoredChat } from '@crewmap/p2p';
import { EMOTE_EMOJI, EMOTE_PRESETS } from '@crewmap/shared/emotes';
import { t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { useApp } from '../../core/store';
import { Bouncy, Chip, Icon, ScreenHeader } from '../../ui/kit';
import { useBackClose } from '../../ui/useBackClose';
import { font, radius, type, useTheme } from '../../ui/theme';

const clock = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/** Chat with one friend (`id` = deviceId) or a whole crew (`id` = `crew:<circleId>`). */
export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const router = useRouter();
  useBackClose(() => (router.canGoBack() ? router.back() : router.replace('/')));
  const rev = useApp((s) => s.chatRev);
  const crewId = crewOfThread(id);
  const title = useApp((s) => (crewId ? (s.crews.find((c) => c.id === crewId)?.name ?? t('chat.crew')) : (s.allFriends[id]?.profile.name ?? t('chat.title'))));
  const friendName = useApp((s) => s.allFriends[id]?.profile.name ?? '');
  // 1:1: false = peer build has no chat; null = unknown (allow). Crew: members known not to support it.
  const blocked = useApp((s) => (!crewId && peerSupports(s.allFriends[id]?.presence, 'chat') === false));
  const cantReceive = useApp((s) => (crewId ? Object.values(s.allFriends).filter((f) => f.crews.includes(crewId) && peerSupports(f.presence, 'chat') === false).length : 0));
  const [msgs, setMsgs] = useState<StoredChat[]>([]);
  const [text, setText] = useState('');
  const list = useRef<FlatList<StoredChat>>(null);
  const [kb, setKb] = useState(false);
  const first = useRef(true);

  // Keyboard up: drop the nav-bar inset under the input (the keyboard covers it) and keep the latest message in view.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      setKb(true);
      requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKb(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    useApp.getState().set({ chatOpen: id });
    return () => useApp.getState().set({ chatOpen: null });
  }, [id]);

  useEffect(() => {
    let live = true;
    void engine.chat.thread(id).then((m) => {
      if (!live) return;
      setMsgs(m);
      if (m.some((x) => !x.mine && !x.read)) void engine.chat.markRead(id);
    });
    return () => {
      live = false;
    };
  }, [id, rev]);

  const send = (s: string) => {
    if (!s.trim() || blocked) return;
    setText('');
    void engine.chat.send(id, s);
  };

  const status = (m: StoredChat) => (m.status === 'delivered' ? '✓✓' : m.status === 'sent' ? '✓' : '!');
  const statusLabel = (m: StoredChat) => t(m.status === 'delivered' ? 'chat.delivered' : m.status === 'sent' ? 'chat.sent' : 'chat.failed');

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: th.bg }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16 }}>
        <ScreenHeader title={title} />
      </View>
      <FlatList
        ref={list}
        data={msgs}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onContentSizeChange={() => {
          // First load jumps straight to the latest message; new messages animate in.
          list.current?.scrollToEnd({ animated: !first.current });
          if (msgs.length) first.current = false;
        }}
        renderItem={({ item, index }) => (
          <View testID={`chat-msg-${index}`} style={[styles.bubble, item.mine ? { alignSelf: 'flex-end', backgroundColor: th.accent } : { alignSelf: 'flex-start', backgroundColor: th.card }]}>
            {crewId && !item.mine && (
              <Text style={[type.caption, font('bold'), { color: th.accent }]}>{useApp.getState().allFriends[item.from]?.profile.name ?? ''}</Text>
            )}
            <Text style={[type.body, { color: item.mine ? th.onAccent : th.text }]}>{item.text}</Text>
            <Text accessibilityLabel={item.mine ? statusLabel(item) : undefined} style={[type.caption, { color: item.mine ? th.onAccent : th.textSoft, alignSelf: 'flex-end', opacity: 0.8 }]}>
              {clock(item.t)}
              {item.mine ? ` ${status(item)}` : ''}
            </Text>
          </View>
        )}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 6 }} style={{ flexGrow: 0 }}>
        {EMOTE_PRESETS.map((p) => (
          <Chip
            key={p}
            testID={`chat-quick-${p}`}
            label={`${EMOTE_EMOJI[p]} ${t(`emote.${p}`)}`}
            onPress={() => {
              if (crewId) send(`${EMOTE_EMOJI[p]} ${t(`emote.${p}`)}`);
              else void engine.emotes.send(id, { preset: p });
            }}
          />
        ))}
      </ScrollView>
      {blocked ? (
        <Text testID="chat-unsupported" style={[type.small, { color: th.textSoft, textAlign: 'center', padding: 16, paddingBottom: insets.bottom + 16 }]}>{t('chat.unsupported', { name: friendName })}</Text>
      ) : (
      <>
      {cantReceive > 0 && <Text testID="chat-partial" style={[type.caption, { color: th.textSoft, paddingHorizontal: 16 }]}>{t('chat.someCantReceive', { n: cantReceive })}</Text>}
      <View style={[styles.inputRow, { paddingBottom: (kb ? 0 : insets.bottom) + 8, borderTopColor: th.separator }]}>
        <TextInput
          testID="chat-input"
          value={text}
          onChangeText={setText}
          placeholder={t('chat.placeholder')}
          placeholderTextColor={th.textFaint}
          maxLength={CHAT_MAX_CHARS}
          multiline
          style={[type.body, styles.input, { color: th.text, backgroundColor: th.cardAlt }]}
        />
        <Bouncy testID="chat-send" accessibilityRole="button" accessibilityLabel={t('chat.send')} disabled={!text.trim()} onPress={() => send(text)} style={[styles.send, { backgroundColor: th.accent, opacity: text.trim() ? 1 : 0.4 }]}>
          <Icon name="send" size={22} color={th.onAccent} />
        </Bouncy>
      </View>
      </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bubble: { maxWidth: '80%', borderRadius: radius.l, paddingHorizontal: 14, paddingVertical: 8, gap: 2 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 48, maxHeight: 120, borderRadius: 24, paddingHorizontal: 16, paddingVertical: 12 },
  send: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
