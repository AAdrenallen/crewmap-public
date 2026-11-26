import { describe, expect, it } from 'vitest';
import { externalArrivalMs, parseExternalNav, type ExternalNavRaw } from '../src/navigation/externalNavParse';

const raw = (app: 'waze' | 'gmaps', title: string | null, text: string | null, subText: string | null = null, bigText: string | null = null): ExternalNavRaw => ({
  app,
  title,
  text,
  subText,
  bigText,
  t: 1000,
});

type Exp = { remainingMin: number | null; remainingKm: number | null; arrival: string | null; nextInstruction: string | null };

const cases: [string, ExternalNavRaw, Exp][] = [
  // Captured from a real Google Maps navigation notification on the OnePlus 8 (2026-11-24): empty title, p.m. clock.
  ['gmaps real device (en-CA, p.m.)', raw('gmaps', '', 'toward Rue Birch', '34 min · 42 km · 5:09 p.m. ETA'), { remainingMin: 34, remainingKm: 42, arrival: '17:09', nextInstruction: 'toward Rue Birch' }],
  ['gmaps en classic', raw('gmaps', '350 m', 'Turn left onto Avenue Maple', '12 min · 8.3 km · 11:43 ETA'), { remainingMin: 12, remainingKm: 8.3, arrival: '11:43', nextInstruction: '350 m · Turn left onto Avenue Maple' }],
  ['gmaps fr comma decimal', raw('gmaps', '350 m', 'Tournez à gauche sur Avenue Maple', '12 min · 8,3 km · Arrivée prévue à 11:43'), { remainingMin: 12, remainingKm: 8.3, arrival: '11:43', nextInstruction: '350 m · Tournez à gauche sur Avenue Maple' }],
  ['gmaps hours', raw('gmaps', '2 km', 'Continue onto A1', '1 h 05 min · 112 km · 13:20 ETA'), { remainingMin: 65, remainingKm: 112, arrival: '13:20', nextInstruction: '2 km · Continue onto A1' }],
  ['gmaps hr min en', raw('gmaps', '1.5 km', 'Take exit 12', '2 hr 3 min · 180 km · 15:02 ETA'), { remainingMin: 123, remainingKm: 180, arrival: '15:02', nextInstruction: '1.5 km · Take exit 12' }],
  ['gmaps fr h only', raw('gmaps', '5 km', 'Restez sur la voie de gauche', '2 h · 190 km · Arrivée 14 h 10'), { remainingMin: 120, remainingKm: 190, arrival: '14:10', nextInstruction: '5 km · Restez sur la voie de gauche' }],
  ['gmaps instruction in title', raw('gmaps', 'Turn right onto Rue de Rivoli', 'toward Louvre', '7 min · 2.1 km · 09:05 ETA'), { remainingMin: 7, remainingKm: 2.1, arrival: '09:05', nextInstruction: 'Turn right onto Rue de Rivoli' }],
  ['gmaps 12h am/pm', raw('gmaps', '200 ft', 'Turn left onto Main St', '9 min · 3.2 mi · 11:43 PM ETA'), { remainingMin: 9, remainingKm: 5.1, arrival: '23:43', nextInstruction: '60 m · Turn left onto Main St' }],
  ['gmaps 12 am', raw('gmaps', null, 'Head north', '5 min · 1 km · ETA 12:04 AM'), { remainingMin: 5, remainingKm: 1, arrival: '00:04', nextInstruction: 'Head north' }],
  ['gmaps missing distance', raw('gmaps', null, 'Keep right', '4 min · 10:15 ETA'), { remainingMin: 4, remainingKm: null, arrival: '10:15', nextInstruction: 'Keep right' }],
  ['gmaps summary in bigText', raw('gmaps', '800 m', 'Serrez à droite', null, '25 min (21 km) · Arrivée prévue à 18:47'), { remainingMin: 25, remainingKm: 21, arrival: '18:47', nextInstruction: '800 m · Serrez à droite' }],
  ['gmaps metres remaining', raw('gmaps', '50 m', 'Your destination is on the right', '1 min · 350 m · 08:01 ETA'), { remainingMin: 1, remainingKm: 0.4, arrival: '08:01', nextInstruction: '50 m · Your destination is on the right' }],
  ['gmaps rond-point', raw('gmaps', '400 m', 'Au rond-point, prenez la 2e sortie', '18 min · 14,6 km · Arrivée prévue à 07:52'), { remainingMin: 18, remainingKm: 14.6, arrival: '07:52', nextInstruction: '400 m · Au rond-point, prenez la 2e sortie' }],
  ['waze en', raw('waze', 'Turn right onto Avenue Maple', 'In 350 m', 'ETA 11:43 · 12 min · 8.3 km'), { remainingMin: 12, remainingKm: 8.3, arrival: '11:43', nextInstruction: '350 m · Turn right onto Avenue Maple' }],
  ['waze fr', raw('waze', 'Tournez à droite', 'Dans 350 m', 'Arrivée 11 h 43 · 12 min'), { remainingMin: 12, remainingKm: null, arrival: '11:43', nextInstruction: '350 m · Tournez à droite' }],
  ['waze fr 11h43 compact', raw('waze', 'Prenez la sortie', 'Dans 1,2 km', 'Arrivée 11h43 · 1 h 5 min · 98,4 km'), { remainingMin: 65, remainingKm: 98.4, arrival: '11:43', nextInstruction: '1.2 km · Prenez la sortie' }],
  ['waze arriving at', raw('waze', 'Keep left', 'In 2 km', 'Arriving at 17:30'), { remainingMin: null, remainingKm: null, arrival: '17:30', nextInstruction: '2 km · Keep left' }],
  ['waze left', raw('waze', 'Make a U-turn', null, '23 min left · 19 km'), { remainingMin: 23, remainingKm: 19, arrival: null, nextInstruction: 'Make a U-turn' }],
  ['waze reste fr', raw('waze', 'Continuez tout droit', null, 'Reste 8 min · 4,5 km'), { remainingMin: 8, remainingKm: 4.5, arrival: null, nextInstruction: 'Continuez tout droit' }],
  ['waze comma in text', raw('waze', null, 'Dans 350 m, tournez à gauche', 'ETA 10:00'), { remainingMin: null, remainingKm: null, arrival: '10:00', nextInstruction: '350 m · tournez à gauche' }],
  ['waze mins plural', raw('waze', 'Exit right', 'In 600 m', '45 mins · 52.7 km · ETA 20:15'), { remainingMin: 45, remainingKm: 52.7, arrival: '20:15', nextInstruction: '600 m · Exit right' }],
  ['bullet separator', raw('gmaps', '300 m', 'Slight left', '6 min • 2.4 km • 16:20 ETA'), { remainingMin: 6, remainingKm: 2.4, arrival: '16:20', nextInstruction: '300 m · Slight left' }],
  ['only summary', raw('gmaps', null, null, '3 min · 900 m · 12:00 ETA'), { remainingMin: 3, remainingKm: 0.9, arrival: '12:00', nextInstruction: null }],
  ['bare clock no keyword', raw('gmaps', null, 'Turn left', '14 min · 9 km · 12:30'), { remainingMin: 14, remainingKm: 9, arrival: '12:30', nextInstruction: 'Turn left' }],
  ['minutes word', raw('waze', 'Turn left', null, '17 minutes · 11 km'), { remainingMin: 17, remainingKm: 11, arrival: null, nextInstruction: 'Turn left' }],
];

describe('parseExternalNav', () => {
  it.each(cases)('%s', (_name, r, exp) => {
    expect(parseExternalNav(r)).toEqual({ app: r.app, t: 1000, ...exp });
  });

  it('ignores idle / unrelated notifications', () => {
    expect(parseExternalNav(raw('waze', 'Waze', 'Waze is running in the background'))).toBeNull();
    expect(parseExternalNav(raw('gmaps', null, null))).toBeNull();
    expect(parseExternalNav(raw('gmaps', 'Location sharing', 'Your location is shared with 2 people'))).toBeNull();
  });

  it('rejects impossible clock times', () => {
    expect(parseExternalNav(raw('gmaps', null, 'Turn left', 'ETA 27:90'))?.arrival).toBeNull();
  });
});

describe('externalArrivalMs', () => {
  it('prefers remaining time', () => {
    expect(externalArrivalMs({ app: 'waze', remainingMin: 10, remainingKm: null, arrival: '23:00', nextInstruction: null, t: 0 }, 5000)).toBe(605_000);
  });
  it('rolls clock time past midnight', () => {
    const now = new Date(2026, 0, 1, 23, 50).getTime();
    const ms = externalArrivalMs({ app: 'gmaps', remainingMin: null, remainingKm: null, arrival: '00:10', nextInstruction: null, t: now }, now)!;
    expect(ms - now).toBe(20 * 60_000);
  });
  it('null without data', () => {
    expect(externalArrivalMs({ app: 'gmaps', remainingMin: null, remainingKm: null, arrival: null, nextInstruction: null, t: 0 })).toBeNull();
  });
});
