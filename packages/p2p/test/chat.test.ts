import { describe, expect, it } from 'vitest';
import { CircleAdmin, replay, type CircleOp } from '../src/crypto/circle';
import { generateIdentity, publicIdentity, type DeviceIdentity } from '../src/crypto/identity';
import { open } from '../src/crypto/envelope';
import { fromUtf8, unb64 } from '../src/crypto/sodium';
import { Router, type Incoming } from '../src/router';
import { CHAT_MAX_CHARS, ChatStore, MemoryChatPersistence, decodeChat, encodeChat, threadOf, crewThread, type ChatMessage, type StoredChat } from '../src/chat';
import { DEFAULT_SHARING, chatAllowed, normalizePolicy } from '../src/sharing';
import { TestNet, tick } from './net';

function crew(n: number) {
  const ids = Array.from({ length: n }, () => generateIdentity());
  const admin = new CircleAdmin(ids[0]!);
  let log: CircleOp[] = admin.create('Crew', 'P0', Date.now());
  for (let i = 1; i < n; i++) log = [...log, ...admin.add(replay(log, ids[0]!), publicIdentity(ids[i]!), `P${i}`, Date.now())];
  return { ids, log };
}

function phone(net: TestNet, id: DeviceIdentity, log: CircleOp[]) {
  const st = replay(log, id);
  const router = new Router({ self: id, circle: () => st, pool: net.pool(id.deviceId), publicRelays: ['wss://t'], retryMs: [50, 100] });
  router.start(Math.floor(Date.now() / 1000) - 60);
  return { id, st, router };
}

const msg = (from: DeviceIdentity, to: DeviceIdentity | null, text = 'on my way'): ChatMessage => ({ id: `m-${Math.random().toString(36).slice(2)}`, from: from.deviceId, to: to?.deviceId ?? null, text, t: Date.now() });

describe('chat encryption', () => {
  it('1:1 round-trips to the recipient only', () => {
    const [a, b, c] = [generateIdentity(), generateIdentity(), generateIdentity()];
    const m = msg(a, b, 'secret plan');
    const wire = encodeChat(m, b.boxPk);
    expect(fromUtf8(wire)).not.toContain('secret plan');
    expect(decodeChat(wire, a.deviceId, b)).toEqual(m);
    expect(decodeChat(wire, a.deviceId, c)).toBeNull();
  });

  it('rejects a sender mismatch and over-long text', () => {
    const [a, b, c] = [generateIdentity(), generateIdentity(), generateIdentity()];
    const wire = encodeChat(msg(a, b), b.boxPk);
    // c relays a's sealed payload under its own envelope: the inner sender does not match.
    expect(decodeChat(wire, c.deviceId, b)).toBeNull();
    expect(() => encodeChat(msg(a, null, 'x'.repeat(CHAT_MAX_CHARS + 1)))).toThrow();
    expect(() => encodeChat(msg(a, b))).toThrow();
  });

  it('crew message is readable by every member', () => {
    const [a, b] = [generateIdentity(), generateIdentity()];
    const m = msg(a, null);
    expect(decodeChat(encodeChat(m), a.deviceId, b)).toEqual(m);
  });

  it('unicast privacy: another crew member opens the envelope but not the 1:1 text', async () => {
    const net = new TestNet();
    const { ids, log } = crew(3);
    const [a, b, c] = ids.map((id) => phone(net, id, log));
    const got: Incoming[] = [];
    b!.router.on('chat', (m) => got.push(m));
    const m = msg(a!.id, b!.id, 'only for B');
    await a!.router.sendTo(b!.id.deviceId, 'chat', encodeChat(m, b!.id.boxPk));
    await tick();
    expect(got).toHaveLength(1);
    expect(decodeChat(got[0]!.payload, got[0]!.sender, b!.id)?.text).toBe('only for B');

    // C holds the crew key: take the relay event itself and open it as C would.
    const ev = net.published.find((e) => {
      try {
        return open(c!.st, unb64(e.content)).kind === 'chat';
      } catch {
        return false;
      }
    });
    expect(ev).toBeDefined();
    const opened = open(c!.st, unb64(ev!.content));
    expect(opened.sender).toBe(a!.id.deviceId);
    expect(fromUtf8(opened.payload)).not.toContain('only for B');
    expect(decodeChat(opened.payload, opened.sender, c!.id)).toBeNull();
  });

  it('1:1 chat is acked (delivered state)', async () => {
    const net = new TestNet();
    const { ids, log } = crew(2);
    const [a, b] = ids.map((id) => phone(net, id, log));
    b!.router.on('chat', () => undefined);
    const reports: boolean[] = [];
    a!.router.onDelivery((r) => reports.push(r.ok));
    await a!.router.sendTo(b!.id.deviceId, 'chat', encodeChat(msg(a!.id, b!.id), b!.id.boxPk));
    for (let i = 0; i < 20 && reports.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(reports).toEqual([true]);
  });

  it('policy: chat needs emotes and chat, old policies default to allowed', () => {
    expect(chatAllowed(DEFAULT_SHARING)).toBe(true);
    expect(chatAllowed({ ...DEFAULT_SHARING, emotes: false })).toBe(false);
    expect(chatAllowed({ ...DEFAULT_SHARING, chat: false })).toBe(false);
    const { chat: _c, ...old } = DEFAULT_SHARING;
    expect(chatAllowed(normalizePolicy(old))).toBe(true);
  });
});

describe('chat store', () => {
  const row = (p: Partial<StoredChat>): StoredChat => ({ id: 'x', from: 'f', to: null, text: 'hi', t: 1000, thread: 't1', mine: false, status: 'delivered', read: false, ...p });

  it('dedupes, counts unread, marks read', async () => {
    const s = new ChatStore(new MemoryChatPersistence());
    expect(await s.add(row({ id: '1' }))).toBe(true);
    expect(await s.add(row({ id: '1' }))).toBe(false);
    await s.add(row({ id: '2', t: 2000 }));
    await s.add(row({ id: '3', thread: 't2' }));
    await s.add(row({ id: '4', mine: true, status: 'sent' }));
    expect(await s.unread()).toEqual({ t1: 2, t2: 1 });
    await s.markRead('t1');
    expect(await s.unread()).toEqual({ t2: 1 });
    expect((await s.thread('t1')).map((r) => r.id)).toEqual(['1', '4', '2']);
  });

  it('delivery moves forward only', async () => {
    const p = new MemoryChatPersistence();
    const s = new ChatStore(p);
    await s.add(row({ id: '1', mine: true, status: 'sent' }));
    await s.setStatus('1', 'delivered', 'sent');
    await s.setStatus('1', 'failed', 'delivered');
    expect(p.rows.get('1')!.status).toBe('delivered');
  });

  it('retention purge and thread delete', async () => {
    const s = new ChatStore(new MemoryChatPersistence());
    const now = 40 * 86_400_000;
    await s.add(row({ id: 'old', t: now - 31 * 86_400_000 }));
    await s.add(row({ id: 'new', t: now - 86_400_000 }));
    await s.add(row({ id: 'other', thread: 't2', t: now }));
    expect(await s.purge(30, now)).toBe(1);
    await s.deleteThread('t2');
    expect((await s.thread('t1')).map((r) => r.id)).toEqual(['new']);
    expect(await s.thread('t2')).toEqual([]);
  });

  it('threads: 1:1 keyed by the other device, crew by circle', () => {
    expect(threadOf({ id: '1', from: 'me', to: 'bob', text: 'a', t: 0 }, 'me', 'c1')).toBe('bob');
    expect(threadOf({ id: '1', from: 'bob', to: 'me', text: 'a', t: 0 }, 'me', 'c1')).toBe('bob');
    expect(threadOf({ id: '1', from: 'bob', to: null, text: 'a', t: 0 }, 'me', 'c1')).toBe(crewThread('c1'));
  });
});
