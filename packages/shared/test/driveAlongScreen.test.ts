import { describe, expect, it } from 'vitest';
import { driveAlongScreenState, newSession } from '../src/companions';

const me = { id: 'me', name: 'Me' };
const ann = { id: 'ann', name: 'Ann' };
const dest = { name: 'Eiffel Tower', lat: 48.8584, lng: 2.2945 };

describe('driveAlongScreenState', () => {
  it('no session: host picker, send needs a destination and a pick', () => {
    expect(driveAlongScreenState(null, 'me', 0, true, false).canSend).toBe(false);
    expect(driveAlongScreenState(null, 'me', 1, false, false).canSend).toBe(false);
    const s = driveAlongScreenState(null, 'me', 1, true, false);
    expect(s).toMatchObject({ host: true, canSend: true, manage: false, stop: null, shareRoute: false });
    expect(driveAlongScreenState(null, 'me', 1, true, true).canSend).toBe(false);
  });

  it('after inviting with nothing picked: still manageable, options editable, end offered', () => {
    const session = newSession('s1', me, [ann], null, 0, dest);
    const s = driveAlongScreenState(session, 'me', 0, true, false);
    expect(s).toMatchObject({ host: true, manage: true, shareRoute: true, changeDest: true, leave: true, stop: 'end', canSend: false });
  });

  it('host alone: no hand-over leave, but end still works', () => {
    const session = newSession('s1', me, [], null, 0, dest);
    expect(driveAlongScreenState(session, 'me', 0, true, false)).toMatchObject({ leave: false, stop: 'end' });
  });

  it('member: no host controls, can leave', () => {
    const session = newSession('s1', ann, [me], null, 0, dest);
    expect(driveAlongScreenState(session, 'me', 2, true, false)).toMatchObject({ host: false, canSend: false, shareRoute: false, changeDest: false, leave: false, stop: 'leave' });
  });
});
