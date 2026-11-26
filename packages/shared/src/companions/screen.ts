import type { DriveAlongSession } from './session';

/** What the drive-together screen offers for a given session and pick state. Back is never gated. */
export interface DriveAlongScreenState {
  /** I host (or will host) the drive: destination, crewmate picker and send are shown. */
  host: boolean;
  /** Send invites: needs a destination and at least one picked crewmate. */
  canSend: boolean;
  /** A session exists: its member list with live status is shown. */
  manage: boolean;
  /** Host-only session controls stay editable after inviting. */
  shareRoute: boolean;
  changeDest: boolean;
  /** Host leaves without ending it for the others (only once someone else is in it). */
  leave: boolean;
  /** End for everyone (host) / leave (member). */
  stop: 'end' | 'leave' | null;
}

export function driveAlongScreenState(
  session: DriveAlongSession | null,
  meId: string,
  pickedCount: number,
  hasDest: boolean,
  sending: boolean,
): DriveAlongScreenState {
  const host = !session || session.owner === meId;
  const owner = !!session && session.owner === meId;
  return {
    host,
    canSend: host && hasDest && pickedCount > 0 && !sending,
    manage: !!session,
    shareRoute: owner,
    changeDest: owner,
    leave: owner && Object.keys(session.members).length > 1,
    stop: session ? (owner ? 'end' : 'leave') : null,
  };
}
