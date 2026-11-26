import { extractInviteLink } from '@crewmap/shared/links';

/** An invite link received before the profile existed. Kept in memory and (via `store`) on disk, so it survives onboarding and a process kill. Stored as `crewmap://join#…` whichever form came in. */
export interface InviteStore {
  read(): Promise<string | null>;
  write(link: string | null): Promise<void>;
}

export function createInviteStash(store: InviteStore) {
  let mem: string | null = null;
  const safeWrite = (v: string | null) => store.write(v).catch(() => undefined);
  return {
    /** Remember a link, either form (non-invite text is ignored). */
    stash(raw: string): Promise<void> {
      const link = extractInviteLink(raw);
      if (!link) return Promise.resolve();
      mem = link;
      return safeWrite(link);
    },
    /** The pending link without consuming it. */
    peek: (): string | null => mem,
    /** Pending link from memory, else from disk. */
    async load(): Promise<string | null> {
      if (mem) return mem;
      const v = await store.read().catch(() => null);
      mem = v ? extractInviteLink(v) : null;
      return mem;
    },
    /** Drop it once the join succeeded (or the user chose another path). */
    clear(): Promise<void> {
      mem = null;
      return safeWrite(null);
    },
  };
}
