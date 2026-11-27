import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { platform } from '@crewmap/platform';
import { lang, t } from '@crewmap/shared/i18n';
import { ACTION, CATEGORY, categoryFor, type NotifData } from './notifRoutes';

/** Local notifications for everything computed on-device (arrivals, emotes, crash, moments). */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let readyLang: string | null = null;
let pending: Promise<void> | null = null;

async function applyLocale(): Promise<void> {
  const l = lang();
  // Circle events (invites, messages, emotes, asks) pop up as heads-up banners. A channel's importance can't be raised after it
  // exists, so the old default-importance 'circle' channel is replaced by 'crew'.
  await Notifications.deleteNotificationChannelAsync('circle').catch(() => undefined);
  await Notifications.setNotificationChannelAsync('crew', { name: t('notif.chanCircle'), importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 150, 250], lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE });
  // The always-on "sharing location" foreground-service notification: its channels (expo-location's ids) are created first at
  // minimum importance, so it stays out of the status bar and never sits above the real alerts.
  if (Platform.OS === 'android') {
    const quiet = { importance: Notifications.AndroidImportance.MIN, sound: null, vibrationPattern: [0], showBadge: false, enableVibrate: false };
    const pkg = Constants.expoConfig?.android?.package;
    await Notifications.setNotificationChannelAsync('expo.location.next.notification.channel', { name: t('notif.sharing'), ...quiet }).catch(() => undefined);
    if (pkg) await Notifications.setNotificationChannelAsync(`${pkg}:crewmap-location`, { name: t('notif.sharing'), ...quiet }).catch(() => undefined);
  }
  // Same circle messages without sound or vibration (chat while driving).
  await Notifications.setNotificationChannelAsync('circleQuiet', { name: t('notif.chanQuiet'), importance: Notifications.AndroidImportance.LOW, sound: null, vibrationPattern: [0] });
  await Notifications.setNotificationChannelAsync('alerts', { name: t('notif.chanAlerts'), importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 400, 200, 400] });
  const bg = { opensAppToForeground: false };
  await Notifications.setNotificationCategoryAsync(CATEGORY.chat, [
    { identifier: ACTION.reply, buttonTitle: t('notif.reply'), textInput: { submitButtonTitle: t('chat.send'), placeholder: t('notif.replyHint') }, options: bg },
    { identifier: ACTION.markRead, buttonTitle: t('notif.markRead'), options: bg },
  ]);
  await Notifications.setNotificationCategoryAsync(CATEGORY.arrival, [{ identifier: ACTION.navigate, buttonTitle: t('notif.navigate'), options: { opensAppToForeground: true } }]);
  await Notifications.setNotificationCategoryAsync(CATEGORY.emote, [
    { identifier: ACTION.sendBack, buttonTitle: t('notif.sendBack'), options: bg },
    { identifier: ACTION.pingThink, buttonTitle: t('notif.pingThink'), options: bg },
    { identifier: ACTION.pingOmw, buttonTitle: t('notif.pingOmw'), options: bg },
  ]);
  // Safety check-in (D66): one big answer, from the lock screen too.
  await Notifications.setNotificationCategoryAsync(CATEGORY.checkIn, [{ identifier: ACTION.imOk, buttonTitle: t('checkIn.ok'), options: bg }]);
  readyLang = l;
}

/** Creates channels and action categories in the current app language; redoes them when the language changed. */
export async function syncNotificationLocale(): Promise<void> {
  if (readyLang === lang()) return;
  pending ??= applyLocale().finally(() => {
    pending = null;
  });
  await pending;
  if (readyLang !== lang()) await syncNotificationLocale();
}

export function notificationsPermission(): Promise<'granted' | 'denied' | 'undetermined'> {
  return platform.notifications.permission();
}

export async function requestNotifications(): Promise<'granted' | 'denied' | 'undetermined'> {
  const r = await platform.notifications.request();
  void syncNotificationLocale().catch(() => undefined);
  return r;
}

export async function notify(title: string, body: string, opts: { channel?: 'circle' | 'alerts'; data?: NotifData; silent?: boolean; identifier?: string } = {}): Promise<void> {
  await syncNotificationLocale();
  const channel = opts.silent && (opts.channel ?? 'circle') === 'circle' ? 'circleQuiet' : (opts.channel ?? 'circle') === 'circle' ? 'crew' : 'alerts';
  const data = opts.data ?? {};
  const categoryIdentifier = categoryFor(data);
  // Same identifier = the earlier notification is replaced (one per conversation / repeated emote).
  await Notifications.scheduleNotificationAsync({
    ...(opts.identifier ? { identifier: opts.identifier } : {}),
    content: { title, body, data: { ...data }, ...(categoryIdentifier ? { categoryIdentifier } : {}), ...(opts.silent ? { sound: false } : {}) },
    trigger: { channelId: channel } as Notifications.NotificationTriggerInput,
  });
}
