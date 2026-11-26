import { StyleSheet, View } from 'react-native';
import { useApp } from '../core/store';
import { Chip } from './kit';

/** One-tap per-crew sharing for an own place. A crew whose policy has places off shows a ghost icon (master switch). */
export function PlaceShareChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const crews = useApp((s) => s.crews);
  const sharing = useApp((s) => s.sharing);
  return (
    <View style={styles.wrap}>
      {crews.map((c) => {
        const on = value.includes(c.id);
        return (
          <Chip
            key={c.id}
            testID={`place-share-${c.name}`}
            label={c.name}
            active={on}
            icon={sharing[c.id]?.places === false ? 'ghost' : undefined}
            onPress={() => onChange(on ? value.filter((x) => x !== c.id) : [...value, c.id])}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } });
