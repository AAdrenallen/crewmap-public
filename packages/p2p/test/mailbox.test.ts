import { describe, expect, it } from 'vitest';
import { CircleAdmin, replay, type CircleOp } from '../src/crypto/circle';
import { generateIdentity, publicIdentity } from '../src/crypto/identity';
import { absorbLog, Mailbox } from '../src/mailbox';
import { TestNet, tick } from './net';

describe('X1 membership log delivery via per-device mailbox', () => {
  it('a member offline across two rotations catches up, including a gap request', async () => {
    const net = new TestNet();
    const owner = generateIdentity();
    const alex = generateIdentity();
    const sam = generateIdentity();
    const admin = new CircleAdmin(owner);
    let log: CircleOp[] = admin.create('Crew', 'O', 1);
    log = [...log, ...admin.add(replay(log, owner), publicIdentity(alex), 'Alex', 2)];
    let alexLog = [...log];
    log = [...log, ...admin.add(replay(log, owner), publicIdentity(sam), 'Sam', 3)];
    log = [...log, ...admin.rotate(replay(log, owner), 4)];
    log = [...log, ...admin.remove(replay(log, owner), sam.deviceId, 5)];

    const requests: number[] = [];
    const ownerBox = new Mailbox(net.pool(owner.deviceId), () => ['wss://t'], owner, () => undefined, (_c, _from, fromSeq) => requests.push(fromSeq));
    const alexBox = new Mailbox(net.pool(alex.deviceId), () => ['wss://t'], alex, (_c, ops) => {
      const r = absorbLog(alexLog, ops, alex);
      if (r === 'gap') void alexBox.requestLog({ boxPk: publicIdentity(owner).boxPk }, replay(log).circleId, alexLog.length, Date.now());
      else if (r) alexLog = r;
    }, () => undefined);
    ownerBox.start(Date.now(), 0);
    alexBox.start(Date.now(), 0);

    // Owner sends only the last 2 ops → Alex detects the gap and asks.
    await ownerBox.sendLog(publicIdentity(alex), replay(log).circleId, log.slice(-2), Date.now());
    await tick();
    expect(requests).toEqual([alexLog.length]);
    // Owner answers with the missing range.
    await ownerBox.sendLog(publicIdentity(alex), replay(log).circleId, log.slice(requests[0]), Date.now());
    await tick();
    const st = replay(alexLog, alex);
    expect(st.seq).toBe(replay(log).seq);
    expect(st.members.has(sam.deviceId)).toBe(false);
    expect(st.epochKeys.has(st.epoch)).toBe(true);
  });
});
