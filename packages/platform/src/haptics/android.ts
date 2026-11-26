import * as Haptics from 'expo-haptics';
import type { HapticsService } from '../contracts';

export const androidHaptics: HapticsService = {
  play: (kind) => {
    switch (kind) {
      case 'tap':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        break;
      case 'select':
        void Haptics.selectionAsync();
        break;
      case 'bounce':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        break;
      case 'success':
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;
      case 'warning':
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        break;
    }
  },
};
