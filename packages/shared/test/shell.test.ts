import { describe, expect, it } from 'vitest';
import { FIRST_TIME_PROMPTS, MAIN_SCREENS, TIPS, developerVisible, markTipSeen, tipForScreen, registerUnlockTap, syncState, type TapState } from '../src/shell';

describe('developer unlock', () => {
  it('unlocks on the 7th quick tap', () => {
    let s: TapState = { count: 0, last: 0 };
    let ok = false;
    for (let i = 0; i < 7; i++) ({ state: s, unlocked: ok } = registerUnlockTap(s, 1000 + i * 300));
    expect(ok).toBe(true);
  });
  it('a pause restarts the count', () => {
    let s: TapState = { count: 0, last: 0 };
    for (let i = 0; i < 6; i++) s = registerUnlockTap(s, 1000 + i * 300).state;
    const r = registerUnlockTap(s, 20_000);
    expect(r.unlocked).toBe(false);
    expect(r.state.count).toBe(1);
  });
  it('visibility: dev build or unlock only', () => {
    expect(developerVisible(false, false)).toBe(false);
    expect(developerVisible(false, true)).toBe(true);
    expect(developerVisible(true, false)).toBe(true);
  });
});

describe('syncState', () => {
  const ok = { online: true, started: true, relaysUp: 2, relaysTotal: 3, queued: 0 };
  it('hidden when healthy', () => expect(syncState(ok)).toBeNull());
  it('offline wins', () => expect(syncState({ ...ok, online: false, queued: 4 })).toEqual({ kind: 'offline' }));
  it('reconnecting when every relay socket is down', () => expect(syncState({ ...ok, relaysUp: 0 })).toEqual({ kind: 'reconnecting' }));
  it('queued count', () => expect(syncState({ ...ok, queued: 3 })).toEqual({ kind: 'queued', n: 3 }));
  it('not started: silent', () => expect(syncState({ ...ok, started: false, relaysUp: 0 })).toBeNull());
});


describe('tips', () => {
  it('only these screens may show first-time prompts', () => {
    expect(Object.keys(FIRST_TIME_PROMPTS).sort()).toEqual(['drive-along', 'quips']);
  });
  it('never on a main screen', () => {
    for (const m of MAIN_SCREENS) expect(tipForScreen(m, [], false)).toBeNull();
    for (const m of MAIN_SCREENS) expect(Object.keys(FIRST_TIME_PROMPTS)).not.toContain(m);
  });
  it('every prompt maps to a known tip', () => {
    const ids: string[] = TIPS.map((x) => x.id);
    for (const id of Object.values(FIRST_TIME_PROMPTS)) expect(ids).toContain(id);
  });
  it('shows once, then never; never while driving', () => {
    expect(tipForScreen('drive-along', [], false)).toBe('drive');
    expect(tipForScreen('drive-along', [], true)).toBeNull();
    const seen = markTipSeen([], 'drive');
    expect(markTipSeen(seen, 'drive')).toEqual(['drive']);
    expect(tipForScreen('drive-along', seen, false)).toBeNull();
    expect(tipForScreen('quips', seen, false)).toBe('quips');
    expect(tipForScreen('constructor', [], false)).toBeNull();
  });
});
