import Svg, { Path } from 'react-native-svg';

export type MusicGlyph = 'play' | 'pause' | 'next' | 'prev' | 'note';

const D: Record<MusicGlyph, string> = {
  play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  next: 'M5 6.2v11.6a.8.8 0 0 0 1.2.7L15 13v4.5a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-2a.5.5 0 0 0-.5.5V11L6.2 5.5a.8.8 0 0 0-1.2.7z',
  prev: 'M19 6.2v11.6a.8.8 0 0 1-1.2.7L9 13v4.5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5V11l8.8-5.5a.8.8 0 0 1 1.2.7z',
  note: 'M9 18.5a3 3 0 1 1-2-2.83V5.6a1 1 0 0 1 .76-.97l10-2.5A1 1 0 0 1 19 3.1v12.4a3 3 0 1 1-2-2.83V6.3l-8 2v10.2z',
};

/** Filled transport glyphs for the driving music controls. */
export function MusicIcon({ name, size = 28, color }: { name: MusicGlyph; size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={D[name]} fill={color} />
    </Svg>
  );
}
