import { useRef } from 'react';
import { ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { CAR_COLORS, carColorOf, CARS, CLEAR_LENS, RIDES_NATURAL, RIDES_WITH_ACCENT, colorOf, FINISH_ITEMS, finishOf, trimOf, withCarAccent, withCarColor, withCarFinish, withCarTint, withColor, withFinish, withLens, withTrim, type AvatarConfig, type AvatarPartKey, type CarConfig, type FinishItem } from '@crewmap/shared/avatar';
import { t, type I18nKey } from '@crewmap/shared/i18n';
import { Bouncy, Chip } from '../kit';
import { Icon } from '../kitIcons';
import { radius, space, type, useTheme } from '../theme';
import { ColorField } from './ColorPicker';
import { FinishPicker } from './FinishPicker';
import { groupOf, hasLens, hasTrim, isLight, PART_GROUPS, partOptions, RIDE_ICON, withPart } from './avatarParts';

/**
 * Avatar and ride pickers shared by the avatar editor and onboarding. testIDs: `<prefix>-tab-<tab>`,
 * `<prefix>-opt-<value>`, `<prefix>-car-<model>` (the editor uses prefix `avatar`, onboarding `onb`).
 */

export function Swatches({ colors, selected, onPick }: { colors: readonly string[]; selected: string; onPick: (c: string) => void }) {
  const th = useTheme();
  return (
    <View style={styles.wrap}>
      {colors.map((c) => {
        const on = selected === c;
        return (
          <Bouncy key={c} haptic="select" accessibilityRole="button" accessibilityLabel={c} accessibilityState={{ selected: on }} onPress={() => onPick(c)} style={[styles.swatch, { borderColor: on ? th.accent : 'transparent' }]}>
            <View style={[styles.swatchInner, { backgroundColor: c, borderColor: th.border }]}>{on && <Icon name="check" color={isLight(c) ? '#111111' : '#FFFFFF'} size={20} strokeWidth={3} />}</View>
          </Bouncy>
        );
      })}
    </View>
  );
}

/** Part tabs, wrapped (not a sideways scroller: every category stays visible). */
export function PartTabs<K extends string>({ tabs, active, onPick, testPrefix }: { tabs: readonly K[]; active: K; onPick: (k: K) => void; testPrefix: string }) {
  return (
    <View style={styles.tabs}>
      {tabs.map((k) => (
        <Chip key={k} testID={`${testPrefix}-tab-${k}`} label={t(`avatar.${k}` as I18nKey)} active={active === k} onPress={() => onPick(k)} />
      ))}
    </View>
  );
}

export const PART_TABS: readonly AvatarPartKey[] = PART_GROUPS.map((g) => g.tab);

const isFinishItem = (k: string): k is FinishItem => (FINISH_ITEMS as readonly string[]).includes(k);

/** Styles of the tab's part, then the colours that paint it. */
function Caption({ k }: { k: I18nKey }) {
  const th = useTheme();
  return <Text style={[type.caption, { color: th.textSoft }]}>{t(k)}</Text>;
}

export function PartOptions({ value, tab, onChange, testPrefix }: { value: AvatarConfig; tab: AvatarPartKey; onChange: (cfg: AvatarConfig) => void; testPrefix: string }) {
  const g = groupOf(tab);
  const trim = g.trim && hasTrim(value, g.trim) ? g.trim : null;
  const lens = g.lens && hasLens(value) ? (value.lens ?? '') : null;
  return (
    <Animated.View key={tab} entering={FadeIn.duration(180)} style={{ gap: space(4) }}>
      <View style={styles.wrap}>
        {partOptions(g.style).map((v) => (
          <Chip key={v} testID={`${testPrefix}-opt-${v}`} label={t(`part.${g.style}.${v}` as I18nKey)} active={value[g.style] === v} onPress={() => onChange(withPart(value, g.style, v))} />
        ))}
      </View>
      {g.color && <ColorField testPrefix={testPrefix} presets={partOptions(g.color)} value={colorOf(value, g.color)} onChange={(c) => onChange(withColor(value, g.color!, c))} />}
      {g.color2 && (
        <>
          <Caption k={`avatar.${g.color2}` as I18nKey} />
          <ColorField testPrefix={`${testPrefix}-2`} presets={partOptions(g.color2)} value={colorOf(value, g.color2)} onChange={(c) => onChange(withColor(value, g.color2!, c))} />
        </>
      )}
      {trim && (
        <>
          <Caption k="avatar.trim" />
          <ColorField testPrefix={`${testPrefix}-trim`} presets={TRIM_PRESETS} value={trimOf(value, trim) ?? ''} specials={[{ kind: 'natural', on: !trimOf(value, trim), onPress: () => onChange(withTrim(value, trim, null)) }]} onChange={(c) => onChange(withTrim(value, trim, c))} />
        </>
      )}
      {lens !== null && (
        <>
          <Caption k="avatar.lens" />
          <ColorField
            testPrefix={`${testPrefix}-lens`}
            presets={LENS_PRESETS}
            value={lens === CLEAR_LENS ? '' : lens}
            specials={[
              { kind: 'natural', on: lens === '', onPress: () => onChange(withLens(value, null)) },
              { kind: 'clear', on: lens === CLEAR_LENS, onPress: () => onChange(withLens(value, CLEAR_LENS)) },
            ]}
            onChange={(c) => onChange(withLens(value, c))}
          />
        </>
      )}
      {isFinishItem(g.tab) && <FinishPicker testPrefix={testPrefix} value={finishOf(value, g.tab)} onChange={(f) => onChange(withFinish(value, g.tab as FinishItem, f))} />}
    </Animated.View>
  );
}

const TRIM_PRESETS = ['#F5F5F5', '#1F2937', '#FF6B6B', '#FFC845', '#5B6CFF', '#2EC4B6'] as const;
const LENS_PRESETS = ['#111827', '#6B4F3A', '#1E88E5', '#E53935', '#43A047', '#FF8FB1', '#FDD835', '#8E44AD'] as const;

const TILE = 84;
const TILE_GAP = space(2.5);

function RideTile({ model, car, onPick, testID }: { model: CarConfig['model']; car: CarConfig; onPick: () => void; testID: string }) {
  const th = useTheme();
  const on = car.model === model;
  const label = t(`vehicle.${model}`);
  return (
    <Bouncy testID={testID} haptic="select" accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={onPick} style={[styles.tile, { borderColor: on ? th.accent : 'transparent', backgroundColor: on ? th.accentSoft : 'transparent' }]}>
      <View style={[styles.tileIcon, { backgroundColor: on ? carColorOf(car) : th.cardAlt, borderColor: th.border }]}>
        <Icon name={RIDE_ICON[model]} size={30} color={on ? (isLight(carColorOf(car)) ? '#111111' : '#FFFFFF') : th.textSoft} />
      </View>
      <Text maxFontSizeMultiplier={1.2} numberOfLines={2} style={[type.caption, { color: on ? th.text : th.textSoft, textAlign: 'center' }]}>
        {label}
      </Text>
    </Bouncy>
  );
}

/** Ride tiles (glyph + name) and paint swatches. `scroll` is one sideways row (onboarding); `wrap` a grid (editor). */
export function RidePicker({ car, onChange, layout, testPrefix }: { car: CarConfig; onChange: (car: CarConfig) => void; layout: 'wrap' | 'scroll'; testPrefix: string }) {
  const th = useTheme();
  const scroller = useRef<ScrollViewInstance>(null);
  const tiles = CARS.map((m) => <RideTile key={m} model={m} car={car} testID={`${testPrefix}-car-${m}`} onPick={() => onChange({ ...car, model: m })} />);
  return (
    <View style={{ gap: space(4) }}>
      {layout === 'scroll' ? (
        <ScrollView
          ref={scroller}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: TILE_GAP, paddingHorizontal: space(1) }}
          onLayout={() => {
            const i = CARS.indexOf(car.model);
            if (i > 1) scroller.current?.scrollTo({ x: (i - 1) * (TILE + TILE_GAP), animated: false });
          }}
        >
          {tiles}
        </ScrollView>
      ) : (
        <View style={[styles.wrap, { gap: TILE_GAP }]}>{tiles}</View>
      )}
      {RIDES_NATURAL.includes(car.model) ? (
        <ColorField testPrefix={`${testPrefix}-paint`} presets={CAR_COLORS} value={car.tint ? carColorOf(car) : ''} specials={[{ kind: 'natural', on: !car.tint, onPress: () => onChange(withCarTint(car, false)) }]} onChange={(c) => onChange(withCarTint(withCarColor(car, c), true))} />
      ) : (
        <ColorField testPrefix={`${testPrefix}-paint`} presets={CAR_COLORS} value={carColorOf(car)} onChange={(c) => onChange(withCarColor(car, c))} />
      )}
      {layout === 'wrap' && (
        <>
          <FinishPicker testPrefix={`${testPrefix}-paint`} value={car.finish ?? 'none'} onChange={(f) => onChange(withCarFinish(car, f))} />
          {RIDES_WITH_ACCENT.includes(car.model) && (
            <>
              <Text style={[type.caption, { color: th.textSoft }]}>{t('avatar.accent')}</Text>
              <ColorField testPrefix={`${testPrefix}-accent`} presets={CAR_COLORS} value={car.accent ?? ''} specials={[{ kind: 'natural', on: !car.accent, onPress: () => onChange(withCarAccent(car, null)) }]} onChange={(c) => onChange(withCarAccent(car, c))} />
            </>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2.5) },
  swatch: { width: 52, height: 52, borderRadius: 26, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  swatchInner: { width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  tile: { width: TILE, alignItems: 'center', gap: space(1.5), paddingVertical: space(2), paddingHorizontal: space(1), borderRadius: radius.m, borderWidth: 2 },
  tileIcon: { width: 56, height: 56, borderRadius: radius.m, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
});
