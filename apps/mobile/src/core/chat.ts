import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { chatNotif, notifIdFor } from '@crewmap/shared/messaging';
import { platform } from '@crewmap/platform';
import {
  CHAT_MAX_CHARS,
  ChatStore,
  crewOfThread,
  decodeChat,
  encodeChat,
  hex,
  sodium,
  threadOf,
  unb64,
  type ChatMessage,
  type DeviceIdentity,
  type StoredChat,
} from '@crewmap/p2p';
import { t } from '@crewmap/shared/i18n';
import type { Crews } from './crews';
import { chatDb } from './db';
import { say } from './nav';
import { isMuted } from './friendPrefs';
import { notifyMode } from '../ui/drive/driveUx';
import { friendContextNow } from './friendContext';
import { notify } from './notify';
import { blipFor, useBlips } from './msgNotify';
import { rideMuted } from './rideMutes';
import { useApp } from './store';

/**
 * Chat (1:1 and crew). Messages ride router kind `chat` through the crew's policy; 1:1 text is sealed to the
 * recipient (see packages/p2p/src/chat.ts). History lives only in the local `chat` table.
 */
export class Chat {
  readonly store = new ChatStore(chatDb);
  /** Envelope id → chat id, for delivery acks (this session). */
  private readonly pending = new Map<string, string>();
  private offs: (() => void)[] = [];
  private deliveryHooked = false;

  constructor(
    private readonly crews: Crews,
    private readonly me: DeviceIdentity,
  ) {}

  start(): void {
    const r = this.crews.router;
    if (!r) return;
    this.stop();
    this.offs.push(r.on('chat', (m, crewId) => void this.receive(m.payload, m.sender, crewId)));
    if (!this.deliveryHooked) {
      this.deliveryHooked = true;
      r.onDelivery((d) => {
        if (d.kind !== 'chat') return;
        const id = this.pending.get(d.id);
        if (!id) return;
        this.pending.delete(d.id);
        void chatDb.setStatus(id, d.ok ? 'delivered' : 'failed').then(() => this.bump());
      });
    }
    void this.refreshUnread();
  }

  stop(): void {
    for (const o of this.offs) o();
    this.offs = [];
  }

  /** Send text to a thread (friend deviceId or `crew:<id>`). Returns false when no crew may carry it. */
  async send(thread: string, raw: string): Promise<boolean> {
    const text = raw.trim().slice(0, CHAT_MAX_CHARS);
    if (!text) return false;
    const crewId = crewOfThread(thread);
    const msg: ChatMessage = {
      id: hex(sodium().randombytes_buf(12)),
      from: this.me.deviceId,
      to: crewId ? null : thread,
      text,
      t: Date.now(),
    };
    let envId = '';
    if (crewId) {
      envId = await this.crews.broadcastIn(crewId, 'chat', encodeChat(msg));
    } else {
      const pk = this.crews.boxPkOf(thread);
      if (pk) envId = (await this.crews.router?.sendTo(thread, 'chat', encodeChat(msg, unb64(pk)))) ?? '';
    }
    const row: StoredChat = { ...msg, thread, mine: true, status: envId ? 'sent' : 'failed', read: true };
    await this.store.add(row);
    // Crew messages are broadcast: no per-recipient ack, they stay "sent".
    if (envId && !crewId) this.pending.set(envId, msg.id);
    this.bump();
    return !!envId;
  }

  thread(thread: string): Promise<StoredChat[]> {
    return this.store.thread(thread);
  }

  async markRead(thread: string): Promise<void> {
    await this.store.markRead(thread);
    await this.refreshUnread();
    useBlips.getState().dismiss(thread);
    void Notifications.dismissNotificationAsync(notifIdFor('chat', thread)).catch(() => undefined);
  }

  async purge(retentionDays: number): Promise<void> {
    await this.store.purge(retentionDays, Date.now());
    await this.refreshUnread();
  }

  async deleteThread(thread: string): Promise<void> {
    await this.store.deleteThread(thread);
    await this.refreshUnread();
    this.bump();
  }

  async refreshUnread(): Promise<void> {
    useApp.getState().set({ chatUnread: await this.store.unread() });
  }

  private bump(): void {
    useApp.getState().set({ chatRev: useApp.getState().chatRev + 1 });
  }

  private async receive(payload: Uint8Array, sender: string, crewId: string): Promise<void> {
    const m = decodeChat(payload, sender, this.me);
    if (!m || m.from === this.me.deviceId) return;
    const thread = threadOf(m, this.me.deviceId, crewId);
    const s = useApp.getState();
    const viewing = s.chatOpen === thread && AppState.currentState === 'active';
    if (!(await this.store.add({ ...m, thread, mine: false, status: 'delivered', read: viewing }))) return;
    await this.refreshUnread();
    this.bump();
    if (viewing) return;
    const name = this.crews.doc.profile(m.from)?.name ?? s.allFriends[m.from]?.profile.name ?? '';
    const crewName = m.to === null ? (s.crews.find((c) => c.id === crewId)?.name ?? '') : '';
    const title = crewName ? t('notif.chatCrew', { name, crew: crewName }) : name;
    const driving = s.driving || s.nav?.active === true;
    // While driving: silent, never read aloud unless the owner opted in (and voice is fully on).
    const { ctx, next } = friendContextNow();
    // Ride mutes ('Mute {name}' / 'Mute all', until the ride ends) silence chat notices too.
    const muted = isMuted(m.from) || rideMuted(m.from);
    const foreground = AppState.currentState === 'active';
    // Foreground: the chat bubble plus a quiet banner (unless that chat is open); background: one updating notification per conversation.
    if (foreground) blipFor({ thread, from: m.from, name, kind: crewName ? 'chatCrew' : 'chat1', viewing, muted });
    if (!(foreground && viewing) && !muted && notifyMode('chat', ctx, next) !== 'skip') {
      const n = chatNotif(
        { title, text: m.text, unread: useApp.getState().chatUnread[thread] ?? 1, hidePreview: s.settings.hideChatPreviews },
        { count: (k) => t('notif.newMsgs', { n: String(k) }), hidden: t('notif.newMsg') },
      );
      void notify(n.title, n.body, {
        channel: 'circle',
        silent: foreground || notifyMode('chat', ctx, next) === 'silent',
        identifier: notifIdFor('chat', thread),
        data: { type: 'chat', chatId: thread, friendId: m.from },
      }).catch(() => undefined);
    }
    if (driving && !muted && s.settings.voice === 'on' && s.settings.readChatAloud)
      say(`${name}. ${m.text}`, 'guidance');
    else if (!driving && AppState.currentState === 'active') platform.haptics.play('bounce');
  }
}
