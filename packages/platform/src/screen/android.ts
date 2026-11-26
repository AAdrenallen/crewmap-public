import type { ScreenService } from '../contracts';
import { native } from '../native';

/**
 * Phone-handling signal. Android doesn't let apps observe touches in other apps (that would need an accessibility
 * service, which we don't use), so handling = screen unlocked and interactive while moving, plus touches inside
 * CrewMap that aren't on the driving UI. docs/DRIVING.md explains the limits.
 */
export const androidScreen: ScreenService = {
  current: () => native.getScreenState(),
  onChange: (cb) => {
    const sub = native.addListener('onScreen', cb);
    return () => sub.remove();
  },
};
