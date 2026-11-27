import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { normalizeHex } from '@crewmap/shared/avatar';
import { t } from '@crewmap/shared/i18n';
import { Bouncy } from '../kit';
import { Icon } from '../kitIcons';
import { radius, space, type, useTheme } from '../theme';
import { isLight } from './avatarParts';
import { hexToHsv, hsvToHex, hueAt, svAt, type Hsv } from './colorMath';
import { addRecentColor, loadRecentColors, useRecentColors } from './recentColors';

const SV_H = 150;
const HUE_H = 28;
const HUE_STOPS = [0, 60, 120, 180, 240, 300, 360];

function Swatch({ color, on, onPress, testID }: { color: string; on: boolean; onPress: () => void; testID?: string }) {
  const th = useTheme();
  return (
    <Bouncy testID={testID} haptic="select" accessibilityRole="button" accessibilityLabel={color} accessibilityState={{ selected: on }} onPress={onPress} style={[styles.swatch, { borderColor: on ? th.accent : 'transparent' }]}>
      <View style={[styles.swatchInner, { backgroundColor: color, borderColor: th.border }]}>{on && <Icon name="check" color={isLight(color) ? '#111111' : '#FFFFFF'} size={20} strokeWidth={3} />}</View>
    </Bouncy>
  );
}

/** Saturation/value square + hue bar + hex field. Drags report live; the final colour joins the recents. */
function HsvPanel({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const th = useTheme();
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [text, setText] = useState(value);
  const [w, setW] = useState(0);
  const cur = useRef(hsv);
  cur.current = hsv;
  const own = useRef(value);
  // Gestures are built once per width: call the latest callback, not the one captured then.
  const report = useRef(onChange);
  report.current = onChange;
  // External changes (preset tap, shuffle) move the handles; our own emissions do not reset the hue.
  useEffect(() => {
    if (value === own.current) return;
    own.current = value;
    setHsv(hexToHsv(value));
    setText(value);
  }, [value]);

  const emit = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    own.current = hex;
    setText(hex);
    report.current(hex);
  };
  const commit = () => addRecentColor(hsvToHex(cur.current));

  const sv = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .onBegin((e) => emit({ ...cur.current, ...svAt(e.x, e.y, w, SV_H) }))
        .onUpdate((e) => emit({ ...cur.current, ...svAt(e.x, e.y, w, SV_H) }))
        .onFinalize(commit),
    [w],
  );
  const hue = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .onBegin((e) => emit({ ...cur.current, h: hueAt(e.x, w) }))
        .onUpdate((e) => emit({ ...cur.current, h: hueAt(e.x, w) }))
        .onFinalize(commit),
    [w],
  );
  const pure = hsvToHex({ h: hsv.h, s: 1, v: 1 });

  return (
    <View style={{ gap: space(3) }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {w > 0 && (
        <>
          <GestureDetector gesture={sv}>
            <View testID="color-sv" style={{ width: w, height: SV_H, borderRadius: radius.m, overflow: 'hidden' }}>
              <Svg width={w} height={SV_H}>
                <Defs>
                  <LinearGradient id="sat" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor="#FFFFFF" />
                    <Stop offset="1" stopColor={pure} />
                  </LinearGradient>
                  <LinearGradient id="val" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor="#000000" stopOpacity={0} />
                    <Stop offset="1" stopColor="#000000" stopOpacity={1} />
                  </LinearGradient>
                </Defs>
                <Rect width={w} height={SV_H} fill="url(#sat)" />
                <Rect width={w} height={SV_H} fill="url(#val)" />
              </Svg>
              <View pointerEvents="none" style={[styles.knob, { left: hsv.s * w - 11, top: (1 - hsv.v) * SV_H - 11, backgroundColor: hsvToHex(hsv) }]} />
            </View>
          </GestureDetector>
          <GestureDetector gesture={hue}>
            <View testID="color-hue" style={{ width: w, height: HUE_H, borderRadius: HUE_H / 2, overflow: 'hidden' }}>
              <Svg width={w} height={HUE_H}>
                <Defs>
                  <LinearGradient id="hue" x1="0" y1="0" x2="1" y2="0">
                    {HUE_STOPS.map((h) => (
                      <Stop key={h} offset={h / 360} stopColor={hsvToHex({ h: h % 360, s: 1, v: 1 })} />
                    ))}
                  </LinearGradient>
                </Defs>
                <Rect width={w} height={HUE_H} fill="url(#hue)" />
              </Svg>
              <View pointerEvents="none" style={[styles.knob, { left: (hsv.h / 360) * w - 11, top: HUE_H / 2 - 11, backgroundColor: pure }]} />
            </View>
          </GestureDetector>
        </>
      )}
      <View style={[styles.hexRow, { backgroundColor: th.cardAlt, borderColor: th.border }]}>
        <View style={[styles.hexDot, { backgroundColor: normalizeHex(text) ?? value, borderColor: th.border }]} />
        <TextInput
          testID="color-hex"
          accessibilityLabel={t('avatar.hex')}
          value={text}
          onChangeText={(s) => {
            setText(s);
            const hex = normalizeHex(s);
            if (hex && s.replace('#', '').length === 6) {
              own.current = hex;
              setHsv(hexToHsv(hex));
              onChange(hex);
            }
          }}
          onSubmitEditing={() => {
            const hex = normalizeHex(text);
            if (!hex) return setText(value);
            own.current = hex;
            setHsv(hexToHsv(hex));
            onChange(hex);
            addRecentColor(hex);
          }}
          onBlur={() => setText(value)}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={7}
          style={[type.body, { flex: 1, color: th.text, paddingVertical: space(2) }]}
        />
      </View>
    </View>
  );
}

/** A non-colour choice before the swatches: `natural` keeps the built-in look, `clear` is see-through. */
export interface SpecialSwatch {
  kind: 'natural' | 'clear';
  on: boolean;
  onPress: () => void;
}

function Special({ kind, on, onPress, testID }: SpecialSwatch & { testID: string }) {
  const th = useTheme();
  const label = t(kind === 'clear' ? 'avatar.clear' : 'avatar.natural');
  return (
    <Bouncy testID={testID} haptic="select" accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={onPress} style={[styles.swatch, { borderColor: on ? th.accent : 'transparent' }]}>
      <View style={[styles.swatchInner, { overflow: 'hidden', borderColor: th.border, backgroundColor: kind === 'clear' ? 'transparent' : th.cardAlt, borderStyle: kind === 'clear' ? 'dashed' : 'solid', borderWidth: kind === 'clear' ? 2 : StyleSheet.hairlineWidth }]}>
        <Icon name={on ? 'check' : kind === 'clear' ? 'eye' : 'undo'} size={18} strokeWidth={3} color={th.textSoft} />
      </View>
    </Bouncy>
  );
}

/**
 * Any-colour picker for one slot: preset swatches, recent picks, and a custom tile that opens the HSV panel.
 * `testPrefix` keeps the legacy swatch ids unchanged (they had none); the custom tile is `<prefix>-color-custom`.
 */
export function ColorField({ value, presets, onChange, testPrefix, specials = [] }: { value: string; presets: readonly string[]; onChange: (hex: string) => void; testPrefix: string; specials?: readonly SpecialSwatch[] }) {
  const th = useTheme();
  const recents = useRecentColors((s) => s.list);
  const [open, setOpen] = useState(false);
  useEffect(() => void loadRecentColors(), []);
  const extra = recents.filter((c) => !presets.includes(c));
  const custom = !!value && !specials.some((x) => x.on) && !presets.includes(value) && !extra.includes(value);
  return (
    <View style={{ gap: space(3) }}>
      <View style={styles.wrap}>
        {specials.map((x) => (
          <Special key={x.kind} testID={`${testPrefix}-color-${x.kind}`} {...x} />
        ))}
        {presets.map((c) => (
          <Swatch key={c} color={c} on={value === c} onPress={() => onChange(c)} />
        ))}
        {extra.map((c) => (
          <Swatch key={`r${c}`} color={c} on={value === c} onPress={() => onChange(c)} />
        ))}
        <Bouncy testID={`${testPrefix}-color-custom`} haptic="select" accessibilityRole="button" accessibilityLabel={t('avatar.customColor')} accessibilityState={{ selected: custom, expanded: open }} onPress={() => setOpen((o) => !o)} style={[styles.swatch, { borderColor: custom || open ? th.accent : 'transparent' }]}>
          <View style={[styles.swatchInner, { overflow: 'hidden', borderColor: th.border }]}>
            <Svg width={40} height={40} style={StyleSheet.absoluteFill}>
              <Defs>
                <LinearGradient id="cw" x1="0" y1="0" x2="1" y2="1">
                  {HUE_STOPS.map((h) => (
                    <Stop key={h} offset={h / 360} stopColor={hsvToHex({ h: h % 360, s: 0.8, v: 1 })} />
                  ))}
                </LinearGradient>
              </Defs>
              <Rect width={40} height={40} fill="url(#cw)" />
            </Svg>
            <View style={[styles.customDot, { backgroundColor: custom ? value : th.card }]}>
              <Icon name={custom ? 'check' : 'plus'} size={14} strokeWidth={3} color={custom ? (isLight(value) ? '#111111' : '#FFFFFF') : th.text} />
            </View>
          </View>
        </Bouncy>
      </View>
      {open && <HsvPanel value={value || presets[0] || '#FFFFFF'} onChange={onChange} />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2.5) },
  swatch: { width: 52, height: 52, borderRadius: 26, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  swatchInner: { width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  customDot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  knob: { position: 'absolute', width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: '#FFFFFF', elevation: 3, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  hexRow: { flexDirection: 'row', alignItems: 'center', gap: space(2.5), paddingHorizontal: space(3), borderRadius: radius.m, borderWidth: StyleSheet.hairlineWidth },
  hexDot: { width: 22, height: 22, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth },
});
