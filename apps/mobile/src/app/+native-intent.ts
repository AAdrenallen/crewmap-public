import { inviteRoute } from '@crewmap/shared/links';

/** Incoming URLs → routes. Invites in either form (`crewmap://join#…`, the https join page) open /join with the normalised link. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return inviteRoute(path);
  } catch {
    return path;
  }
}
