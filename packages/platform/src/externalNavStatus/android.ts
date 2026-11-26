import { parseExternalNav } from '@crewmap/shared/navigation/externalNavParse';
import type { ExternalNavStatusService } from '../contracts';
import { native } from '../native';

const asApp = (a: string) => (a === 'waze' || a === 'gmaps' ? a : null);

/**
 * Kotlin `NavStatusListener` (NotificationListenerService) forwards only Waze / Google Maps ongoing navigation
 * notifications, raw; parsing happens here and the raw strings are dropped right after.
 */
export const androidExternalNavStatus: ExternalNavStatusService = {
  hasAccess: () => native.navStatusHasAccess(),
  requestAccess: () => native.navStatusRequestAccess(),
  onUpdate: (cb) => {
    const sub = native.addListener('onExternalNavRaw', (e) => {
      const app = asApp(e.app);
      if (!app) return;
      const u = parseExternalNav({ ...e, app });
      if (u) cb(u);
    });
    return () => sub.remove();
  },
  onEnded: (cb) => {
    const sub = native.addListener('onExternalNavEnded', (e) => {
      const app = asApp(e.app);
      if (app) cb({ app, t: e.t });
    });
    return () => sub.remove();
  },
};
