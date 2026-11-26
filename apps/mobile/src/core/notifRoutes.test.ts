import { describe, expect, it } from 'vitest';
import { ACTION, categoryFor, commandFor, navigatePath, readData, routeFor, type NotifData } from './notifRoutes';

describe('readData', () => {
  it('keeps only known string fields', () => {
    expect(readData({ type: 'chat', chatId: 'c1', junk: 3, friendId: 5 })).toEqual({ type: 'chat', chatId: 'c1' });
    expect(readData(null)).toEqual({});
    expect(readData({ type: 'nope' })).toEqual({});
  });
});

describe('routeFor', () => {
  const cases: [NotifData, string][] = [
    [{ type: 'emote', friendId: 'f1' }, '/friend/f1'],
    [{ type: 'chat', chatId: 'crew:x' }, '/chat/crew%3Ax'],
    [{ type: 'arrival', friendId: 'f1', placeId: 'p1' }, '/friend/f1'],
    [{ type: 'departure', placeId: 'p1' }, '/place/p1'],
    [{ type: 'hazard', hazardId: 'h1' }, '/hazard/h1'],
    [{ type: 'trip', tripId: 't1' }, '/trips/t1'],
    [{ type: 'moment', friendId: 'f2' }, '/friend/f2'],
  ];
  it.each(cases)('%j -> %s', (d, path) => expect(routeFor(d)).toBe(path));
  it('returns null without target', () => {
    expect(routeFor({ type: 'hazard' })).toBeNull();
    expect(routeFor({ type: 'crash' })).toBeNull();
    expect(routeFor({})).toBeNull();
    expect(routeFor({ type: 'driveAlong', friendId: 'a' })).toBe('/drive-along');
    expect(routeFor({ type: 'friendAlert', friendId: 'a' })).toBe('/friend/a');
  });
});

describe('categoryFor', () => {
  it('assigns action categories', () => {
    expect(categoryFor({ type: 'chat', chatId: 'c' })).toBe('chat');
    expect(categoryFor({ type: 'arrival', friendId: 'f' })).toBe('arrival');
    expect(categoryFor({ type: 'emote', friendId: 'f', preset: 'honkHonk' })).toBe('emote');
    expect(categoryFor({ type: 'emote', friendId: 'f', preset: 'custom' })).toBeUndefined();
    expect(categoryFor({ type: 'departure', friendId: 'f' })).toBeUndefined();
  });
});

describe('commandFor', () => {
  const chat: NotifData = { type: 'chat', chatId: 'c1' };
  it('replies with text, opens the chat without text', () => {
    expect(commandFor(ACTION.reply, chat, ' hi ')).toEqual({ kind: 'reply', chatId: 'c1', text: 'hi' });
    expect(commandFor(ACTION.reply, chat, '  ')).toEqual({ kind: 'open', path: '/chat/c1' });
  });
  it('marks read, navigates, sends back', () => {
    expect(commandFor(ACTION.markRead, chat)).toEqual({ kind: 'markRead', chatId: 'c1' });
    expect(commandFor(ACTION.navigate, { type: 'arrival', friendId: 'f', placeName: 'P' })).toEqual({ kind: 'navigate', friendId: 'f', placeName: 'P' });
    expect(commandFor(ACTION.sendBack, { type: 'emote', friendId: 'f', preset: 'hurryUp' })).toEqual({ kind: 'sendBack', friendId: 'f', preset: 'hurryUp' });
    expect(commandFor(ACTION.sendBack, { type: 'emote', friendId: 'f', preset: 'custom' })).toEqual({ kind: 'open', path: '/friend/f' });
  });
  it('falls back to the tap route', () => {
    expect(commandFor('expo.default', { type: 'hazard', hazardId: 'h' })).toEqual({ kind: 'open', path: '/hazard/h' });
    expect(commandFor('x', {})).toBeNull();
  });
});

describe('navigatePath', () => {
  it('encodes the name', () => expect(navigatePath('A B', 1.5, -2)).toBe('/route?name=A%20B&lat=1.5&lng=-2'));
});
