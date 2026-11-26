import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { platform } from '@crewmap/platform';
import { t } from '@crewmap/shared/i18n';
import { Bouncy, Icon } from '../kit';
import { radius, type, useTheme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';
import { DECK, DECK_W, END_KEY, deckCardWidth, deckItems, enterDelay, fadeEdges, focusChanged, topIndex } from './deckLogic';

/** Soft fade into the sheet colour along one edge (pointer-transparent). */
function Fade({ edge, color }: { edge: 'top' | 'bottom'; color: string }) {
  const top = edge === 'top';
  return (
    <View pointerEvents="none" style={[styles.fade, top ? { top: 0 } : { bottom: 0 }]}>
      <Svg width="100%" height={DECK.fade}>
        <Defs>
          <LinearGradient id={`deck-fade-${edge}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={top ? 1 : 0} />
            <Stop offset="1" stopColor={color} stopOpacity={top ? 0 : 1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={DECK.fade} fill={`url(#deck-fade-${edge})`} />
      </Svg>
    </View>
  );
}

/**
 * Compact vertical list for the bottom crewmate area: two full cards and a peek of the third, native momentum scrolling,
 * soft edge fades, a dashed "invite" card as the last row. When a user scroll settles, `onFocus` reports the friend now at
 * the top (the map follows); mount, programmatic changes and the invite row never trigger it. Taps and long-presses go to
 * the cards' own pressables.
 */
export function CrewDeck({
  ids,
  renderCard,
  onFocus,
  onInvite,
  testID,
}: {
  ids: readonly string[];
  renderCard: (id: string) => ReactNode;
  onFocus?: (id: string) => void;
  onInvite: () => void;
  testID?: string;
}) {
  const th = useTheme();
  const reduce = useReduceMotion();
  const [boxW, setBoxW] = useState(0);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const data = useMemo(() => deckItems(ids), [ids]);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const y = useRef(0);
  const viewH = useRef(0);
  const contentH = useRef(0);
  const user = useRef(false);
  const settled = useRef(0);

  const updateEdges = useCallback(() => {
    const e = fadeEdges(y.current, viewH.current, contentH.current);
    setEdges((p) => (p.top === e.top && p.bottom === e.bottom ? p : e));
  }, []);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      y.current = e.nativeEvent.contentOffset.y;
      updateEdges();
    },
    [updateEdges],
  );
  const settle = useCallback(() => {
    const next = topIndex(y.current, data.length);
    const id = focusChanged(settled.current, next, idsRef.current, user.current);
    user.current = false;
    if (next !== settled.current && !reduce) platform.haptics.play('select');
    settled.current = next;
    if (id && onFocus) onFocus(id);
  }, [data.length, onFocus, reduce]);

  const onBegin = useCallback(() => {
    user.current = true;
  }, []);
  const onEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // No momentum follows a slow release: settle now; otherwise onMomentumScrollEnd does.
      if (Math.abs(e.nativeEvent.velocity?.y ?? 0) < 0.05) settle();
    },
    [settle],
  );

  const layout = useCallback(
    (e: LayoutChangeEvent) => {
      setBoxW(Math.round(e.nativeEvent.layout.width));
      viewH.current = e.nativeEvent.layout.height;
      updateEdges();
    },
    [updateEdges],
  );
  const content = useCallback(
    (_w: number, h: number) => {
      contentH.current = h;
      updateEdges();
    },
    [updateEdges],
  );
  const cardW = deckCardWidth(boxW || 360);

  return (
    <View style={styles.wrap} onLayout={layout} testID={testID}>
      <ScrollView
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={32}
        onScroll={onScroll}
        onScrollBeginDrag={onBegin}
        onScrollEndDrag={onEndDrag}
        onMomentumScrollEnd={settle}
        onContentSizeChange={content}
        contentContainerStyle={styles.content}
      >
        {data.map((item, i) => (
          <Animated.View key={item} entering={reduce ? undefined : FadeInDown.delay(enterDelay(i)).duration(DECK.enterMs)} style={{ width: cardW, height: DECK.itemH }}>
            {item === END_KEY ? (
              <Bouncy testID="crew-deck-invite" accessibilityLabel={t('home.invite')} onPress={onInvite} style={[styles.end, { borderColor: th.border, backgroundColor: th.card }]}>
                <Icon name="plus" size={20} color={th.textSoft} />
                <Text style={[type.headline, { color: th.textSoft }]}>{t('home.invite')}</Text>
              </Bouncy>
            ) : (
              renderCard(item)
            )}
          </Animated.View>
        ))}
      </ScrollView>
      {edges.top && <Fade edge="top" color={th.card} />}
      {edges.bottom && <Fade edge="bottom" color={th.card} />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  content: { paddingTop: DECK.padTop, paddingBottom: DECK.padTop, paddingLeft: DECK_W.padLeft, paddingRight: DECK_W.rail, gap: DECK.gap },
  fade: { position: 'absolute', left: 0, right: 0, height: DECK.fade },
  end: {
    height: DECK.itemH,
    borderRadius: radius.l,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
});
