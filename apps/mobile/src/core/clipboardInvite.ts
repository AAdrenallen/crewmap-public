import { extractInviteLink } from '@crewmap/shared/links';

/** The two clipboard calls the pickup needs (expo-clipboard in the app, a fake in tests). */
export interface ClipboardLike {
  getStringAsync(): Promise<string>;
  setStringAsync(text: string): Promise<boolean | void>;
}

/**
 * After installing from the join page (which copied the invite), the first launch finds the invite on the clipboard.
 * Returns the normalised `crewmap://join#…` link, or null. Hands the link to `keep` (the persisted stash) first, then
 * clears the clipboard, and only when it really held an invite, so nothing else the user copied is wiped.
 */
export async function pickupClipboardInvite(clip: ClipboardLike, keep: (link: string) => Promise<void>): Promise<string | null> {
  let text: string;
  try {
    text = await clip.getStringAsync();
  } catch {
    return null;
  }
  const link = text ? extractInviteLink(text) : null;
  if (!link) return null;
  await keep(link);
  await Promise.resolve(clip.setStringAsync('')).catch(() => undefined);
  return link;
}

/** expo-clipboard, loaded lazily: a binary built before it was added has no native module, and the import would throw. */
export async function loadClipboard(): Promise<ClipboardLike | null> {
  try {
    const m = await import('expo-clipboard');
    return { getStringAsync: () => m.getStringAsync(), setStringAsync: (t) => m.setStringAsync(t) };
  } catch {
    return null;
  }
}
