import { describe as d, expect, it } from 'vitest';
import { finite, makeEntry, pushEntry, routeOf, scrub, shortStack } from './errorScrub';

d('errorScrub', () => {
  it('removes coordinates, names, emails and free text', () => {
    const s = scrub('at [-73.5673, 45.50171] Alice said "hello there" to bob@x.io', ['Alice']);
    expect(s).not.toMatch(/73\.5673|45\.5017|Alice|hello|bob@/);
    expect(s).toContain('<num>');
  });
  it('keeps identifier-like quoted values and small numbers', () => {
    expect(scrub('Layer "route-line" missing source "trip", 3 of 12')).toBe('Layer "route-line" missing source "trip", 3 of 12');
  });
  it('strips url queries and long ids', () => {
    const s = scrub('GET https://api.mapbox.com/x?access_token=pk.abc id=abcdefghijklmnopqrstuvwxyz0123');
    expect(s).not.toMatch(/pk\.abc|abcdefghijklmnop/);
  });
  it('shortens stacks to basenames', () => {
    const st = shortStack('Error: x\n at f (D:\\Users\\me\\app\\a.js:1:2)\n at g (/data/user/0/b.bundle:3:4)');
    expect(st).toBe('at f (a.js:1:2)\nat g (b.bundle:3:4)');
  });
  it('rotates', () => {
    let l = [] as ReturnType<typeof makeEntry>[];
    for (let i = 0; i < 205; i++) l = pushEntry(l, makeEntry('js', new Error(`e${i}`), 'index', [], i));
    expect(l).toHaveLength(200);
    expect(l[0]!.t).toBe(5);
  });
  it('routes and finite', () => {
    expect(routeOf(['friend', '[id]'])).toBe('friend/[id]');
    expect(routeOf([])).toBe('index');
    expect(finite(Number.NaN)).toBe(false);
    expect(finite(undefined)).toBe(false);
    expect(finite(0)).toBe(true);
  });
});
