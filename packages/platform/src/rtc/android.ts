import {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import type { DirectLinks } from '@crewmap/p2p';
import { b64, unb64 } from '@crewmap/p2p';

/** Public STUN only; no TURN (costs money). If NAT traversal fails, the router uses Nostr instead. */
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const CONNECT_TIMEOUT_MS = 20_000;

type Signal =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice'; candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } };

interface Peer {
  pc: RTCPeerConnection;
  dc: ReturnType<RTCPeerConnection['createDataChannel']> | null;
  open: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  pendingIce: Signal[];
}

/**
 * WebRTC data-channel links (Section 2A option 1). Signalling (offer/answer/ICE) travels through the router as
 * encrypted circle messages. Links are opportunistic: closed after `idleMs` without traffic to save battery.
 */
export class WebRtcLinks implements DirectLinks {
  private readonly peers = new Map<string, Peer>();
  private msg: (peer: string, bytes: Uint8Array) => void = () => undefined;
  private sig: (peer: string, signal: unknown) => void = () => undefined;

  constructor(private readonly selfId: string) {}

  connected(): string[] {
    return [...this.peers.entries()].filter(([, p]) => p.open).map(([id]) => id);
  }

  send(peer: string, bytes: Uint8Array): boolean {
    const p = this.peers.get(peer);
    if (!p?.open || !p.dc) return false;
    try {
      p.dc.send(b64(bytes));
      return true;
    } catch {
      return false;
    }
  }

  onMessage(h: (peer: string, bytes: Uint8Array) => void): void {
    this.msg = h;
  }

  onSignal(h: (peer: string, signal: unknown) => void): void {
    this.sig = h;
  }

  connect(peer: string): void {
    if (this.peers.has(peer)) return;
    const p = this.create(peer);
    const dc = p.pc.createDataChannel('crewmap', { ordered: true });
    this.wireChannel(peer, p, dc);
    void (async () => {
      const offer = await p.pc.createOffer({});
      await p.pc.setLocalDescription(offer);
      this.sig(peer, { type: 'offer', sdp: offer.sdp } satisfies Signal);
    })().catch(() => this.disconnect(peer));
  }

  handleSignal(peer: string, signal: unknown): void {
    const s = signal as Signal;
    void (async () => {
      if (s.type === 'offer') {
        // Glare: both sides offered; the lower device id keeps its offer.
        if (this.peers.has(peer) && this.selfId < peer) return;
        this.disconnect(peer);
        const p = this.create(peer);
        await p.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: s.sdp }));
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        this.sig(peer, { type: 'answer', sdp: answer.sdp } satisfies Signal);
        await this.flushIce(peer);
      } else if (s.type === 'answer') {
        const p = this.peers.get(peer);
        if (!p) return;
        await p.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: s.sdp }));
        await this.flushIce(peer);
      } else if (s.type === 'ice') {
        const p = this.peers.get(peer);
        if (!p) return;
        if (!p.pc.remoteDescription) p.pendingIce.push(s);
        else await p.pc.addIceCandidate(new RTCIceCandidate(s.candidate));
      }
    })().catch(() => this.disconnect(peer));
  }

  disconnect(peer: string): void {
    const p = this.peers.get(peer);
    if (!p) return;
    this.peers.delete(peer);
    if (p.timer) clearTimeout(p.timer);
    try {
      p.dc?.close();
      p.pc.close();
    } catch {
      // already closed
    }
  }

  close(): void {
    for (const id of [...this.peers.keys()]) this.disconnect(id);
  }

  private create(peer: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const p: Peer = { pc, dc: null, open: false, timer: null, pendingIce: [] };
    this.peers.set(peer, p);
    pc.addEventListener('icecandidate', (e) => {
      const c = (e as { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null }).candidate;
      if (c) this.sig(peer, { type: 'ice', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } } satisfies Signal);
    });
    pc.addEventListener('datachannel', (e) => {
      this.wireChannel(peer, p, (e as unknown as { channel: NonNullable<Peer['dc']> }).channel);
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') this.disconnect(peer);
    });
    p.timer = setTimeout(() => {
      if (!p.open) this.disconnect(peer);
    }, CONNECT_TIMEOUT_MS);
    return p;
  }

  private wireChannel(peer: string, p: Peer, dc: NonNullable<Peer['dc']>): void {
    p.dc = dc;
    dc.addEventListener('open', () => {
      p.open = true;
      if (p.timer) clearTimeout(p.timer);
    });
    dc.addEventListener('close', () => this.disconnect(peer));
    dc.addEventListener('message', (e) => {
      const data = (e as unknown as { data: string }).data;
      if (typeof data === 'string') {
        try {
          this.msg(peer, unb64(data));
        } catch {
          // ignore malformed
        }
      }
    });
  }

  private async flushIce(peer: string): Promise<void> {
    const p = this.peers.get(peer);
    if (!p) return;
    const q = p.pendingIce;
    p.pendingIce = [];
    for (const s of q) if (s.type === 'ice') await p.pc.addIceCandidate(new RTCIceCandidate(s.candidate));
  }
}
