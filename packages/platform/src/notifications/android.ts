import { Linking, PermissionsAndroid, Platform } from 'react-native';
import Constants from 'expo-constants';
import type { NotificationPermission, PermissionState } from '../contracts';

const pkg = () => Constants.expoConfig?.android?.package ?? 'app.crewmap';

/**
 * Android 13+ POST_NOTIFICATIONS runtime permission (older versions: granted at install). Some OEM builds
 * (seen on OxygenOS 13) silently refuse the runtime prompt; then we open the app's notification settings page.
 */
export const androidNotifications: NotificationPermission = {
  permission: async (): Promise<PermissionState> => {
    if (Number(Platform.Version) < 33) return 'granted';
    return (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) ? 'granted' : 'undetermined';
  },
  request: async (): Promise<PermissionState> => {
    if (Number(Platform.Version) < 33) return 'granted';
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (r === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
    await Linking.sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', [{ key: 'android.provider.extra.APP_PACKAGE', value: pkg() }]).catch(() => Linking.openSettings());
    return r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'denied' : 'undetermined';
  },
};
