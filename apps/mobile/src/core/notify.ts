import * as Notifications from 'expo-notifications';
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
  await Notifications.setNotificationChannelAsync('circle', { name: t('notif.chanCircle'), importance: Notifications.AndroidImportance.DEFAULT });
  // Same circle messages without sound or vibration (chat while driving).
  await Notifications.setNotificationChannelAsync('circleQuiet', { name: t('notif.chanQuiet'), importance: Notifications.AndroidImportance.LOW, sound: null, vibrationPattern: [0] });
  await Notifications.setNotificationChannelAsync('alerts', { name: t('notif.chanAlerts'), importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 400, 200, 400] });
  const bg = { opensAppToForeground: false };
  await Notifications.setNotificationCategoryAsync(CATEGORY.chat, [
    { identifier: ACTION.reply, buttonTitle: t('notif.reply'), textInput: { submitButtonTitle: t('chat.send'), placeholder: t('notif.replyHint') }, options: bg },
    { identifier: ACTION.markRead, buttonTitle: t('notif.markRead'), options: bg },
  ]);
  await Notifications.setNotificationCategoryAsync(CATEGORY.arrival, [{ identifier: ACTION.navigate, buttonTitle: t('notif.navigate'), options: { opensAppToForeground: true } }]);
  await Notifications.setNotificationCategoryAsync(CATEGORY.emote, [{ identifier: ACTION.sendBack, buttonTitle: t('notif.sendBack'), options: bg }]);
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
  const channel = opts.silent && (opts.channel ?? 'circle') === 'circle' ? 'circleQuiet' : (opts.channel ?? 'circle');
  const data = opts.data ?? {};
  const categoryIdentifier = categoryFor(data);
  // Same identifier = the earlier notification is replaced (one per conversation / repeated emote).
  await Notifications.scheduleNotificationAsync({
    ...(opts.identifier ? { identifier: opts.identifier } : {}),
    content: { title, body, data: { ...data }, ...(categoryIdentifier ? { categoryIdentifier } : {}), ...(opts.silent ? { sound: false } : {}) },
    trigger: { channelId: channel } as Notifications.NotificationTriggerInput,
  });
}
