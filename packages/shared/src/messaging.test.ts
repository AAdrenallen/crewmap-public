import { describe, expect, it } from 'vitest';
import { blipPreview, chatNotif, expireBlips, inAppBlipPolicy, notifIdFor, pushBlip, visibleBlips, type Blip } from './messaging';

const base = { viewing: false, muted: false };

describe('inAppBlipPolicy', () => {
  it('browse shows a bubble for every kind', () => {
    for (const kind of ['chat1', 'chatCrew', 'quip', 'emote'] as const) expect(inAppBlipPolicy({ ...base, ctx: 'browse', kind })).toBe('bubble');
  });
  it('moving: tiny for chat, silent for quips and emotes', () => {
    expect(inAppBlipPolicy({ ...base, ctx: 'driveMoving', kind: 'chat1' })).toBe('tiny');
    expect(inAppBlipPolicy({ ...base, ctx: 'driveMoving', kind: 'chatCrew' })).toBe('tiny');
    expect(inAppBlipPolicy({ ...base, ctx: 'driveMoving', kind: 'quip' })).toBe('silent');
    expect(inAppBlipPolicy({ ...base, ctx: 'driveMoving', kind: 'emote' })).toBe('silent');
  });
  it('stopped: tiny', () => expect(inAppBlipPolicy({ ...base, ctx: 'driveStopped', kind: 'chatCrew' })).toBe('tiny'));
  it('silent when viewing, muted, or the overlay showed the emote', () => {
    expect(inAppBlipPolicy({ ...base, viewing: true, ctx: 'browse', kind: 'chat1' })).toBe('silent');
    expect(inAppBlipPolicy({ ...base, muted: true, ctx: 'browse', kind: 'chat1' })).toBe('silent');
    expect(inAppBlipPolicy({ ...base, ctx: 'browse', kind: 'emote', overlayShown: true })).toBe('silent');
  });
});

const b = (id: string, at: number, tiny = false): Omit<Blip, 'count'> => ({ id, from: id, name: id, kind: 'chat1', tiny, at });

describe('blip stack', () => {
  it('collapses per conversation and moves it to the front', () => {
    let l = pushBlip([], b('a', 1));
    l = pushBlip(l, b('b', 2));
    l = pushBlip(l, b('a', 3));
    expect(l.map((x) => [x.id, x.count])).toEqual([['a', 2], ['b', 1]]);
  });
  it('a full bubble wins over tiny', () => {
    const l = pushBlip(pushBlip([], b('a', 1, false)), b('a', 2, true));
    expect(l[0]?.tiny).toBe(false);
  });
  it('shows 3 then +N, and expires', () => {
    let l: Blip[] = [];
    for (const [i, id] of ['a', 'b', 'c', 'd', 'e'].entries()) l = pushBlip(l, b(id, i * 1000));
    expect(visibleBlips(l)).toMatchObject({ more: 2 });
    expect(visibleBlips(l).shown.map((x) => x.id)).toEqual(['e', 'd', 'c']);
    expect(expireBlips(l, 5500).map((x) => x.id)).toEqual(['e', 'd', 'c', 'b']);
  });
  it('trims a short message preview and keeps the newest snippet on the blip', () => {
    expect(blipPreview('   On   my   way  now!  ')).toBe('On my way now!');
    expect(blipPreview('one two three four five six seven eight nine')).toBe('one two three four five six…');
    let l = pushBlip([], { ...b('a', 100), preview: 'First msg' });
    l = pushBlip(l, { ...b('a', 200), preview: 'Latest update' });
    expect(l[0]?.preview).toBe('Latest update');
  });
});

describe('notification grouping', () => {
  const tr = { count: (n: number) => `${n} new`, hidden: 'New message' };
  it('one id per conversation / emote kind', () => {
    expect(notifIdFor('chat', 'crew:x')).toBe('chat:crew:x');
    expect(notifIdFor('emote', 'f1', 'party')).toBe('emote:f1:party');
  });
  it('counts and previews', () => {
    expect(chatNotif({ title: 'Alex', text: 'hi', unread: 1, hidePreview: false }, tr)).toEqual({ title: 'Alex', body: 'hi' });
    expect(chatNotif({ title: 'Alex', text: 'yo', unread: 3, hidePreview: false }, tr)).toEqual({ title: 'Alex (3)', body: 'yo' });
    expect(chatNotif({ title: 'Alex', text: 'yo', unread: 3, hidePreview: true }, tr).body).toBe('3 new');
    expect(chatNotif({ title: 'Alex', text: 'yo', unread: 1, hidePreview: true }, tr).body).toBe('New message');
  });
});
