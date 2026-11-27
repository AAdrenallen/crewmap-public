import { describe, expect, it } from 'vitest';
import { classifyName, inQuebec, namesFromStep, segmentUtterance, type SpeechLang } from '../src/navigation/nameLang';

const CASES: [string, SpeechLang | null][] = [
  ['Rue de la Gare', 'fr'],
  ['Avenue de la République', 'fr'],
  ['Avenue Maple', 'fr'],
  ['Chemin du Grand-Pré', 'fr'],
  ['Autoroute 50', 'fr'],
  ['Route Camille-Roy', 'fr'],
  ['Mont-Rivière', 'fr'],
  ['Pointe-Claire', 'fr'],
  ['Avenue du Lac-Clair', 'fr'],
  ["Avenue du Lac-Clair", 'fr'],
  ['Rue Centrale', 'fr'],
  ['Boul. Dubois', 'fr'],
  ['Rang Saint-Joachim', 'fr'],
  ['Côte-Saint-Luc', 'fr'],
  ['Chemin de la Côte-des-Neiges', 'fr'],
  ['Sainte-Anne-des-Plaines', 'fr'],
  ['Belle-Rive', 'fr'],
  ['Val-Clair', 'fr'],
  ['Rue Sherbrooke Ouest', 'fr'],
  ['Trois-Rivières', 'fr'],
  ['Cameron Street', 'en'],
  ['Hawkesbury', 'en'],
  ['Lakeshore Road', 'en'],
  ['Main Street East', 'en'],
  ['St Clair Avenue West', 'en'],
  ['St. Lawrence Street', 'en'],
  ['Sparks Street', 'en'],
  ['Bank Street', 'en'],
  ['Highway 417', 'en'],
  ['Prince of Wales Drive', 'en'],
  ['Riverside Drive', 'en'],
  ['Kingston', 'en'],
  ['Cornwall', 'en'],
  ['Yonge Street', 'en'],
  ['A-15', null],
  ['148', null],
  ['QC 117', null],
  ['ON-17', null],
  ['Тверская улица', 'ru'],
];

describe('classifyName', () => {
  it.each(CASES)('%s → %s', (name, want) => {
    expect(classifyName(name, 'fr')).toBe(want);
  });
  it('ambiguous names follow the regional fallback', () => {
    expect(classifyName('Morin', 'fr')).toBe('fr');
    expect(classifyName('Morin', 'en')).toBe('en');
  });
});

describe('segmentUtterance', () => {
  it('reads template words in the voice language and the name in its own', () => {
    expect(segmentUtterance('Turn left onto Rue de la Gare.', ['Rue de la Gare'], 'en', 'fr')).toEqual([
      { text: 'Turn left onto', lang: 'en' },
      { text: 'Rue de la Gare.', lang: 'fr' },
    ]);
  });
  it('route numbers stay in the voice language', () => {
    expect(segmentUtterance('Take exit 35 toward Mont-Rivière', ['A-15', 'Mont-Rivière'], 'en', 'fr')).toEqual([
      { text: 'Take exit 35 toward', lang: 'en' },
      { text: 'Mont-Rivière', lang: 'fr' },
    ]);
    expect(segmentUtterance('Merge onto A-15 North', ['A-15'], 'en', 'fr')).toEqual([{ text: 'Merge onto A-15 North', lang: 'en' }]);
  });
  it('no split when the name matches the voice', () => {
    expect(segmentUtterance('Tournez à gauche sur Rue Centrale', ['Rue Centrale'], 'fr', 'fr')).toEqual([
      { text: 'Tournez à gauche sur Rue Centrale', lang: 'fr' },
    ]);
  });
  it('English names inside a French instruction', () => {
    expect(segmentUtterance('Tournez à droite sur Cameron Street, puis à gauche', ['Cameron Street'], 'fr', 'fr')).toEqual([
      { text: 'Tournez à droite sur', lang: 'fr' },
      { text: 'Cameron Street,', lang: 'en' },
      { text: 'puis à gauche', lang: 'fr' },
    ]);
  });
  it('matches whole words only and prefers the longest name', () => {
    const s = segmentUtterance('Continue on Boulevard Mont-Rivière', ['Mont-Rivière', 'Boulevard Mont-Rivière', 'Bou'], 'ru', 'fr');
    expect(s).toEqual([
      { text: 'Continue on', lang: 'ru' },
      { text: 'Boulevard Mont-Rivière', lang: 'fr' },
    ]);
  });
});

describe('namesFromStep / inQuebec', () => {
  it('collects name, refs and banner text components', () => {
    const names = namesFromStep({
      name: 'Autoroute des Highlands',
      ref: 'A 15; QC 117',
      banners: [
        {
          distanceAlongGeometry: 0,
          primary: { text: 'Mont-Rivière', type: 'off ramp', components: [{ text: 'Mont-Rivière', type: 'text' }, { text: '/', type: 'delimiter' }] },
        },
      ],
    } as never);
    expect(names).toEqual(['Autoroute des Highlands', 'A 15', 'QC 117', 'Mont-Rivière']);
  });
  it('Québec outline', () => {
    expect(inQuebec(45.78, -74.0)).toBe(true); // Mont-Rivière
    expect(inQuebec(45.5, -73.57)).toBe(true); // Montréal
    expect(inQuebec(45.6, -74.6)).toBe(false); // Hawkesbury
    expect(inQuebec(45.42, -75.7)).toBe(false); // Ottawa
    expect(inQuebec(43.65, -79.38)).toBe(false); // Toronto
  });
});

describe('single voice', () => {
  it('reads the whole instruction with one speaker and expands French abbreviations', async () => {
    const { singleVoice, pronounceName } = await import('../src/navigation/nameLang');
    expect(pronounceName('St-Hubert', 'fr')).toBe('Saint-Hubert');
    expect(pronounceName('Ste-Thérèse', 'fr')).toBe('Sainte-Thérèse');
    expect(pronounceName('Boul. Dubois', 'fr')).toBe('Boulevard Dubois');
    expect(pronounceName('St Clair Avenue', 'en')).toBe('St Clair Avenue');
    const segs = segmentUtterance('Take exit 35 toward St-Hubert', ['St-Hubert'], 'en', 'fr');
    expect(singleVoice(segs, 'en')).toEqual([{ text: 'Take exit 35 toward Saint-Hubert', lang: 'en' }]);
  });
});
