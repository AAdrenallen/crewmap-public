import { describe, expect, it } from 'vitest';
import { ACTION, CATEGORY, categoryFor, commandFor, readData, routeFor } from './notifRoutes';

describe('safety check-in notifications (D66)', () => {
  it('reads the new types', () => {
    expect(readData({ type: 'checkIn' }).type).toBe('checkIn');
    expect(readData({ type: 'checkInAlert', friendId: 'f' })).toEqual({ type: 'checkInAlert', friendId: 'f' });
  });
  it('the ask (and the crash notice it replaces) carries the I am OK button', () => {
    expect(categoryFor({ type: 'checkIn' })).toBe(CATEGORY.checkIn);
    expect(categoryFor({ type: 'crash' })).toBe(CATEGORY.checkIn);
    expect(commandFor(ACTION.imOk, { type: 'checkIn' })).toEqual({ kind: 'checkInOk' });
    expect(commandFor(ACTION.imOk, { type: 'crash' })).toEqual({ kind: 'checkInOk' });
    expect(commandFor(ACTION.imOk, { type: 'chat', chatId: 'c' })).toEqual({ kind: 'open', path: '/chat/c' });
  });
  it("a crewmate's alert opens their screen", () => {
    expect(routeFor({ type: 'checkInAlert', friendId: 'a b' })).toBe('/friend/a%20b');
    expect(categoryFor({ type: 'checkInAlert', friendId: 'f' })).toBeUndefined();
  });
});
