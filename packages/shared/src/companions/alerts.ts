import { FRIEND_ALERTS } from './thresholds';

/**
 * Battery-low alert for a friend who shares battery: fires once when they drop below `batteryLowPct` unplugged, and
 * re-arms when they charge or climb back above `batteryRearmPct`. Receiver-side only (battery already passed the
 * friend's own sharing policy). One instance per friend.
 */
export class BatteryWatch {
  private armed = true;

  update(bat: number | null, charging: boolean): boolean {
    if (bat === null) return false;
    if (charging || bat >= FRIEND_ALERTS.batteryRearmPct) {
      this.armed = true;
      return false;
    }
    if (this.armed && bat < FRIEND_ALERTS.batteryLowPct) {
      this.armed = false;
      return true;
    }
    return false;
  }
}

/** "Ask for location": whether to answer a request from `from` now (one fresh update per requester per minute). */
export class LocateLimiter {
  private readonly last = new Map<string, number>();

  allow(from: string, now: number): boolean {
    const prev = this.last.get(from);
    if (prev !== undefined && now - prev < FRIEND_ALERTS.locateAnswerEveryMs) return false;
    this.last.set(from, now);
    return true;
  }
}

/** Live ETA share: resend when the ETA moved enough or the last update is old. */
export function etaShareDue(lastSent: { eta: number; at: number } | null, eta: number, now: number): boolean {
  if (!lastSent) return true;
  return Math.abs(eta - lastSent.eta) >= FRIEND_ALERTS.etaResendDeltaMs || now - lastSent.at >= FRIEND_ALERTS.etaResendEveryMs;
}

/** Wire payload of router kind 'eta-share' (sealed to the recipient). `end` closes the share (arrived / cancelled). */
export interface EtaShare {
  v: 1;
  sid: string;
  dest: string;
  eta: number;
  remainingM: number;
  t: number;
  end?: 'arrived' | 'cancelled';
}

export function parseEtaShare(raw: unknown): EtaShare | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.sid !== 'string' || typeof o.dest !== 'string' || typeof o.eta !== 'number' || typeof o.t !== 'number') return null;
  const end = o.end === 'arrived' || o.end === 'cancelled' ? o.end : undefined;
  return { v: 1, sid: o.sid.slice(0, 64), dest: o.dest.slice(0, 60), eta: o.eta, remainingM: typeof o.remainingM === 'number' ? o.remainingM : 0, t: o.t, ...(end ? { end } : {}) };
}

/**
 * One-shot arrival alert ("notify me once"): what remains of a subscription after it fired for `kind`. Null = delete
 * it; the subscription is returned unchanged when it is recurring or did not ask for this kind.
 */
export function consumeOnce<S extends { arrive: boolean; leave: boolean; drivingHome?: boolean; once?: boolean }>(sub: S, kind: 'arrive' | 'leave' | 'drivingHome'): S | null {
  if (!sub.once) return sub;
  const fired = kind === 'arrive' ? sub.arrive : kind === 'leave' ? sub.leave : !!sub.drivingHome;
  if (!fired) return sub;
  const next = { ...sub, [kind]: false };
  return next.arrive || next.leave || next.drivingHome ? next : null;
}
