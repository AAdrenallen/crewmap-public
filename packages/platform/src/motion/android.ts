import { PermissionsAndroid } from 'react-native';
import { DeviceMotion } from 'expo-sensors';
import type { Activity } from '@crewmap/shared/driving';
import type { ActivityReading, MotionService, PermissionState } from '../contracts';
import { native } from '../native';

const ACTIVITIES: Activity[] = ['automotive', 'cycling', 'running', 'walking', 'still', 'unknown'];
const asActivity = (s: string): Activity => (ACTIVITIES.includes(s as Activity) ? (s as Activity) : 'unknown');

export const androidMotion: MotionService = {
  permission: async () =>
    (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION)) ? 'granted' : 'undetermined',
  request: async (): Promise<PermissionState> => {
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);
    return r === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
  },
  startActivity: async (intervalMs) => {
    await native.startActivityUpdates(intervalMs);
  },
  stopActivity: async () => {
    await native.stopActivityUpdates();
  },
  lastActivity: (): ActivityReading | null => {
    const a = native.getLastActivity();
    return a ? { t: a.t, activity: asActivity(a.activity), confidence: a.confidence } : null;
  },
  onActivity: (cb) => {
    const sub = native.addListener('onActivity', (e) => cb({ t: e.t, activity: asActivity(e.activity), confidence: e.confidence }));
    return () => sub.remove();
  },
  startImu: (hz, cb) => {
    DeviceMotion.setUpdateInterval(Math.round(1000 / hz));
    const sub = DeviceMotion.addListener((m) => {
      const a = m.acceleration;
      if (!a) return;
      cb(Date.now(), Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z));
    });
    return () => sub.remove();
  },
};
