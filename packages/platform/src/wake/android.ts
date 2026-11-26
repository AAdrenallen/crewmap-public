import { AppRegistry } from 'react-native';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import type { WakeChannel } from '../contracts';
import { native } from '../native';

export const PERIODIC_SYNC_TASK = 'crewmap-periodic-sync';
let headless: ((reason: string) => Promise<void>) | null = null;

// Periodic catch-up (WorkManager, ≥ 15 min) for phones that aren't sharing and have no push distributor.
TaskManager.defineTask(PERIODIC_SYNC_TASK, async () => {
  try {
    if (headless) await headless('periodic');
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// Headless JS task started by CrewmapPushService / BootReceiver.
AppRegistry.registerHeadlessTask('CrewmapSync', () => async (data: { reason?: string }) => {
  if (headless) await headless(data?.reason ?? 'push');
});

export const androidWake: WakeChannel = {
  register: () => native.registerPush(),
  unregister: () => native.unregisterPush(),
  endpoint: () => native.getPushEndpoint(),
  distributors: () => native.getPushDistributors(),
  onEndpoint: (cb) => {
    const sub = native.addListener('onPushEndpoint', (e) => cb(e.endpoint));
    return () => sub.remove();
  },
  onPing: (cb) => {
    const sub = native.addListener('onPushMessage', () => cb());
    return () => sub.remove();
  },
  setSharingEnabled: (on) => native.setSharingEnabled(on),
  registerHeadlessSync: (handler) => {
    headless = handler;
    void BackgroundTask.registerTaskAsync(PERIODIC_SYNC_TASK, { minimumInterval: 15 }).catch(() => undefined);
  },
};
