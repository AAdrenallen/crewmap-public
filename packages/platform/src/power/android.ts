import * as Battery from 'expo-battery';
import * as Network from 'expo-network';
import type { PowerService } from '../contracts';
import { native } from '../native';

export const androidPower: PowerService = {
  isIgnoringBatteryOptimizations: () => native.isIgnoringBatteryOptimizations(),
  requestIgnoreBatteryOptimizations: () => native.requestIgnoreBatteryOptimizations(),
  openOemBatterySettings: () => native.openAppBatterySettings(),
  device: () => native.deviceInfo(),
  battery: async () => {
    const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
    return {
      level: Math.round(level * 100),
      charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
    };
  },
  onBattery: (cb) => {
    const a = Battery.addBatteryLevelListener(() => void androidPower.battery().then(cb));
    const b = Battery.addBatteryStateListener(() => void androidPower.battery().then(cb));
    return () => {
      a.remove();
      b.remove();
    };
  },
  network: async () => {
    const s = await Network.getNetworkStateAsync();
    return { online: s.isConnected === true && s.isInternetReachable !== false, wifi: s.type === Network.NetworkStateType.WIFI };
  },
};
