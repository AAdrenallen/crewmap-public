import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { crewOfThread, type StoredChat } from '@crewmap/p2p';
import { BLIP, visibleBlips, type Blip } from '@crewmap/shared/messaging';
import { t } from '@crewmap/shared/i18n';
import { formatClock } from '@crewmap/shared/units';
import { engine } from '../../core/engine';
import { say } from '../../core/nav';
import { useBlips } from '../../core/msgNotify';
import { useApp } from '../../core/store';
import { useFriendContext } from '../drive/DriveHud';
import { Icon } from '../kitIcons';
import { AvatarStill } from '../map/Sprites';
import { elevation, font, palette, radius, type, useTheme } from '../theme';

const SIZE = 48;
const TINY = 34;

/**
 * Messenger-style chat bubbles on the left edge:
 * - New incoming message smoothly pops a compact snippet box out from the bubble for a few seconds.
 * - Tapping a bubble opens a compact non-blocking mini-chat popover right beside it (keeping the navigation map & HUD visible).
 * - Tapping anywhere outside the mini-chat view closes both the popover and the bubble.
 */
export function MsgBlips({ top, left }: { top: number; left: number }) {
  const blips = useBlips((s) => s.blips);
  const active = useBlips((s) => s.active);
  const close = useBlips((s) => s.close);
  const expire = useBlips((s) => s.expire);

  useEffect(() => {
    if (!blips.length) return;
    const h = setInterval(() => expire(Date.now()), 500);
    return () => clearInterval(h);
  }, [blips.length, expire]);

  useEffect(() => {
    if (!active) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [active, close]);

  if (!blips.length && !active) return null;
  const { shown, more } = visibleBlips(blips);
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.layer]}>
      {active && <Pressable testID="msg-mini-backdrop" accessibilityRole="button" accessibilityLabel={t('common.close')} style={StyleSheet.absoluteFill} onPress={close} />}
      <View testID="msg-bubble" pointerEvents="box-none" style={[styles.col, { top, left }]}>
        {shown.map((b) => (
          <Bubble key={b.id} b={b} isOpen={active?.id === b.id} />
        ))}
        {more > 0 && (
          <View style={styles.more}>
            <Text style={styles.moreText}>+{more}</Text>
          </View>
        )}
        {active && <MiniChatPopover b={active} left={left} onClose={close} />}
      </View>
    </View>
  );
}

function Bubble({ b, isOpen }: { b: Blip; isOpen: boolean }) {
  const th = useTheme();
  const open = useBlips((s) => s.open);
  const close = useBlips((s) => s.close);
  const dismiss = useBlips((s) => s.dismiss);
  const avatar = useApp((s) => s.allFriends[b.from]?.profile.avatar);
  const pop = useRef(new Animated.Value(0)).current;
  const dx = useRef(new Animated.Value(0)).current;
  const snippetAnim = useRef(new Animated.Value(0)).current;
  const [showSnippet, setShowSnippet] = useState(!!b.preview);

  useEffect(() => {
    Animated.spring(pop, { toValue: 1, useNativeDriver: true, friction: 6 }).start();
  }, [pop]);

  // Smoothly pop out the compact message preview box from the bubble each time a message arrives, then tuck it back in.
  useEffect(() => {
    if (!b.preview || isOpen) {
      Animated.timing(snippetAnim, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => setShowSnippet(false));
      return;
    }
    setShowSnippet(true);
    snippetAnim.setValue(0);
    Animated.spring(snippetAnim, { toValue: 1, useNativeDriver: true, friction: 7, tension: 85 }).start();
    const timer = setTimeout(() => {
      Animated.timing(snippetAnim, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => setShowSnippet(false));
    }, BLIP.previewMs);
    return () => clearTimeout(timer);
  }, [b.at, b.preview, isOpen, snippetAnim]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => dx.setValue(Math.min(0, g.dx)),
      onPanResponderRelease: (_, g) => {
        if (g.dx < -SIZE / 2) {
          if (isOpen) close();
          else dismiss(b.id);
        } else {
          Animated.spring(dx, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    }),
  ).current;

  const size = b.tiny ? TINY : SIZE;
  const toggle = () => {
    if (isOpen) close();
    else open(b);
  };

  return (
    <Animated.View
      {...pan.panHandlers}
      style={[styles.bubbleRow, { transform: [{ translateX: dx }, { scale: pop }], opacity: pop }]}
    >
      <Pressable testID={`msg-bubble-${b.id}`} onPress={toggle} hitSlop={b.tiny ? 9 : 4} accessibilityRole="button" accessibilityLabel={b.name}>
        <View
          style={[
            styles.bubble,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: th.card,
              borderColor: isOpen ? th.accent : th.separator,
              borderWidth: isOpen ? 2 : StyleSheet.hairlineWidth,
            },
          ]}
        >
          {avatar ? (
            <AvatarStill avatar={avatar} size={size - 4} />
          ) : (
            <Text style={[styles.initial, { color: th.text, fontSize: size * 0.42 }]}>{b.name.slice(0, 1).toUpperCase()}</Text>
          )}
        </View>
        <View style={[styles.badge, b.tiny && styles.badgeTiny]}>
          <Text style={styles.badgeText}>{b.count > 9 ? '9+' : b.count}</Text>
        </View>
      </Pressable>

      {showSnippet && !!b.preview && !isOpen && (
        <Animated.View
          style={{
            opacity: snippetAnim,
            transform: [
              { translateX: snippetAnim.interpolate({ inputRange: [0, 1], outputRange: [-14, 0] }) },
              { scale: snippetAnim.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) },
            ],
          }}
        >
          <Pressable
            testID={`msg-preview-${b.id}`}
            onPress={toggle}
            style={[styles.previewPill, { backgroundColor: th.glass, borderColor: th.separator }, elevation.mid]}
          >
            <Text style={[type.caption, font('bold'), { color: th.accent }]} numberOfLines={1}>
              {b.name}
            </Text>
            <Text style={[type.small, { color: th.text }]} numberOfLines={1}>
              {b.preview}
            </Text>
          </Pressable>
        </Animated.View>
      )}
    </Animated.View>
  );
}

function MiniChatPopover({ b, left, onClose }: { b: Blip; left: number; onClose: () => void }) {
  const th = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const ctx = useFriendContext();
  const driving = useApp((s) => s.driving || s.nav?.active === true);
  const chatRev = useApp((s) => s.chatRev);
  const crews = useApp((s) => s.crews);
  const friends = useApp((s) => s.allFriends);
  const avatar = friends[b.from]?.profile.avatar;
  const crewId = crewOfThread(b.id);
  const title = crewId ? (crews.find((c) => c.id === crewId)?.name ?? t('chat.crew')) : b.name;

  const [msgs, setMsgs] = useState<StoredChat[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const popAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(popAnim, { toValue: 1, useNativeDriver: true, friction: 7, tension: 90 }).start();
  }, [popAnim]);

  useEffect(() => {
    let alive = true;
    void engine.chat.thread(b.id).then((rows) => {
      if (!alive) return;
      setMsgs(rows.slice(-6));
    });
    void engine.chat.markRead(b.id);
    return () => {
      alive = false;
    };
  }, [b.id, chatRev]);

  const sendText = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || sending) return;
      setSending(true);
      await engine.chat.send(b.id, clean).catch(() => false);
      setDraft('');
      setSending(false);
    },
    [b.id, sending],
  );

  const speakLatest = () => {
    const last = [...msgs].reverse().find((m) => !m.mine);
    const text = last?.text ?? b.preview;
    if (text) say(`${b.name}. ${text}`, 'test');
  };

  const openFull = () => {
    const id = b.id;
    onClose();
    router.push(`/chat/${encodeURIComponent(id)}`);
  };

  const cardW = Math.min(312, Math.max(240, width - left - 16));
  const quickReplies = [t('chat.quickOk'), t('chat.quickOmw'), t('chat.quickWait')];

  return (
    <Animated.View
      testID="msg-mini-card"
      style={[
        styles.miniCard,
        {
          width: cardW,
          backgroundColor: th.card,
          borderColor: th.border,
          opacity: popAnim,
          transform: [
            { scale: popAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
            { translateY: popAnim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) },
          ],
        },
        elevation.high,
      ]}
    >
      <View style={[styles.miniHead, { borderBottomColor: th.separator }]}>
        <View style={styles.miniAvatar}>
          {avatar ? (
            <AvatarStill avatar={avatar} size={28} />
          ) : (
            <Text style={[type.small, font('bold'), { color: th.text }]}>{title.slice(0, 1).toUpperCase()}</Text>
          )}
        </View>
        <Text style={[type.headline, { color: th.text, flex: 1 }]} numberOfLines={1}>
          {title}
        </Text>
        <Pressable testID="msg-mini-speak" accessibilityRole="button" accessibilityLabel={t('set.readChatAloud')} hitSlop={8} onPress={speakLatest} style={styles.headBtn}>
          <Icon name="volume" size={18} color={th.textSoft} />
        </Pressable>
        {!driving && (
          <Pressable testID="msg-mini-full" accessibilityRole="button" accessibilityLabel={t('chat.openFull')} hitSlop={8} onPress={openFull} style={styles.headBtn}>
            <Icon name="popup" size={17} color={th.accent} />
          </Pressable>
        )}
        <Pressable testID="msg-mini-close" accessibilityRole="button" accessibilityLabel={t('common.close')} hitSlop={8} onPress={onClose} style={styles.headBtn}>
          <Icon name="close" size={18} color={th.textSoft} />
        </Pressable>
      </View>

      <ScrollView style={{ maxHeight: driving ? 128 : 168 }} contentContainerStyle={styles.msgList} showsVerticalScrollIndicator={false}>
        {msgs.length === 0 && b.preview ? (
          <View style={[styles.msgBubble, { backgroundColor: th.cardAlt, alignSelf: 'flex-start' }]}>
            <Text style={[type.small, { color: th.text }]}>{b.preview}</Text>
          </View>
        ) : (
          msgs.map((m) => {
            const sender = !m.mine && crewId ? (friends[m.from]?.profile.name ?? '') : '';
            return (
              <View
                key={m.id}
                style={[
                  styles.msgBubble,
                  m.mine ? { backgroundColor: th.accent, alignSelf: 'flex-end' } : { backgroundColor: th.cardAlt, alignSelf: 'flex-start' },
                ]}
              >
                {!!sender && <Text style={[type.caption, font('bold'), { color: th.accent }]}>{sender}</Text>}
                <Text style={[type.small, { color: m.mine ? th.onAccent : th.text }]}>{m.text}</Text>
                <Text style={[styles.msgTime, { color: m.mine ? 'rgba(255,255,255,0.72)' : th.textFaint }]}>{formatClock(m.t)}</Text>
              </View>
            );
          })
        )}
      </ScrollView>

      <View style={styles.quickRow}>
        {quickReplies.map((qText) => (
          <Pressable
            key={qText}
            onPress={() => void sendText(qText)}
            style={({ pressed }) => [styles.quickChip, { backgroundColor: th.cardAlt, borderColor: th.border, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[type.caption, font('semibold'), { color: th.text }]}>{qText}</Text>
          </Pressable>
        ))}
      </View>

      {ctx !== 'driveMoving' && (
        <View style={[styles.inputRow, { borderTopColor: th.separator }]}>
          <TextInput
            testID="msg-mini-input"
            value={draft}
            onChangeText={setDraft}
            placeholder={t('chat.placeholder')}
            placeholderTextColor={th.textFaint}
            returnKeyType="send"
            onSubmitEditing={() => void sendText(draft)}
            style={[type.small, styles.input, { color: th.text, backgroundColor: th.cardAlt }]}
          />
          <Pressable
            testID="msg-mini-send"
            accessibilityRole="button"
            accessibilityLabel={t('chat.send')}
            disabled={!draft.trim() || sending}
            onPress={() => void sendText(draft)}
            style={[styles.sendBtn, { backgroundColor: draft.trim() ? th.accent : th.cardAlt }]}
          >
            <Icon name="send" size={16} color={draft.trim() ? th.onAccent : th.textFaint} />
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: { zIndex: 25 },
  col: { position: 'absolute', alignItems: 'flex-start' },
  bubbleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  bubble: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', elevation: 4 },
  initial: { fontWeight: '700' },
  badge: {
    position: 'absolute',
    right: -4,
    top: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: palette.pop,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeTiny: { minWidth: 15, height: 15, borderRadius: 7.5, right: -3, top: -3 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  previewPill: {
    maxWidth: 220,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.m,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 1,
  },
  more: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.55)', marginBottom: 6 },
  moreText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  miniCard: {
    marginTop: 2,
    borderRadius: radius.l,
    borderWidth: 1,
    overflow: 'hidden',
  },
  miniHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  miniAvatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  headBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  msgList: { paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  msgBubble: { maxWidth: '86%', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, gap: 1 },
  msgTime: { fontSize: 10, alignSelf: 'flex-end' },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 10, paddingBottom: 8 },
  quickChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, height: 36, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 0 },
  sendBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
