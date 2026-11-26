import { describe, expect, it } from 'vitest';
import { createInviteStash, type InviteStore } from './inviteStash';

const memStore = (): InviteStore & { v: string | null } => {
  const s = { v: null as string | null, read: async () => s.v, write: async (l: string | null) => void (s.v = l) };
  return s;
};

describe('invite stash', () => {
  it('persists, survives a restart, and is consumed by clear', async () => {
    const disk = memStore();
    const a = createInviteStash(disk);
    await a.stash('crewmap://join#abc');
    expect(a.peek()).toBe('crewmap://join#abc');
    expect(a.peek()).toBe('crewmap://join#abc'); // peeking does not consume
    const b = createInviteStash(disk); // new process
    expect(b.peek()).toBeNull();
    expect(await b.load()).toBe('crewmap://join#abc');
    await b.clear();
    expect(disk.v).toBeNull();
    expect(await createInviteStash(disk).load()).toBeNull();
  });
  it('ignores foreign links and storage errors', async () => {
    const bad: InviteStore = { read: async () => { throw new Error('x'); }, write: async () => { throw new Error('x'); } };
    const s = createInviteStash(bad);
    await s.stash('https://example.com');
    expect(s.peek()).toBeNull();
    await s.stash('crewmap://join#z');
    expect(s.peek()).toBe('crewmap://join#z');
    expect(await createInviteStash(bad).load()).toBeNull();
  });
  it('stores the https form as the internal link', async () => {
    const disk = memStore();
    const s = createInviteStash(disk);
    await s.stash('Join X on CrewMap\nhttps://aadrenallen.github.io/crewmap-public/join/#tok');
    expect(s.peek()).toBe('crewmap://join#tok');
    expect(disk.v).toBe('crewmap://join#tok');
  });
});
