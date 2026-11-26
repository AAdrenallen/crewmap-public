import { describe, expect, it } from 'vitest';
import { pickupClipboardInvite, type ClipboardLike } from './clipboardInvite';

const fakeClip = (v: string, fail = false): ClipboardLike & { v: string } => {
  const c = {
    v,
    getStringAsync: async () => {
      if (fail) throw new Error('no focus');
      return c.v;
    },
    setStringAsync: async (t: string) => {
      c.v = t;
      return true;
    },
  };
  return c;
};

describe('clipboard invite pickup', () => {
  it('finds the https invite the join page copied, keeps it, then clears the clipboard', async () => {
    const clip = fakeClip('https://aadrenallen.github.io/crewmap-public/join/#tok_1');
    const kept: string[] = [];
    const link = await pickupClipboardInvite(clip, async (l) => void kept.push(l));
    expect(link).toBe('crewmap://join#tok_1');
    expect(kept).toEqual(['crewmap://join#tok_1']);
    expect(clip.v).toBe('');
  });
  it('accepts the internal form inside a chat message', async () => {
    const clip = fakeClip('Join X on CrewMap\ncrewmap://join#abc');
    expect(await pickupClipboardInvite(clip, async () => undefined)).toBe('crewmap://join#abc');
  });
  it('leaves unrelated clipboard content alone', async () => {
    const clip = fakeClip('my shopping list');
    let kept = false;
    expect(await pickupClipboardInvite(clip, async () => void (kept = true))).toBeNull();
    expect(kept).toBe(false);
    expect(clip.v).toBe('my shopping list');
  });
  it('survives an empty or unreadable clipboard', async () => {
    expect(await pickupClipboardInvite(fakeClip(''), async () => undefined)).toBeNull();
    expect(await pickupClipboardInvite(fakeClip('crewmap://join#x', true), async () => undefined)).toBeNull();
  });
  it('keeps the link even if clearing fails', async () => {
    const clip: ClipboardLike = { getStringAsync: async () => 'crewmap://join#x', setStringAsync: async () => { throw new Error('denied'); } };
    expect(await pickupClipboardInvite(clip, async () => undefined)).toBe('crewmap://join#x');
  });
});
