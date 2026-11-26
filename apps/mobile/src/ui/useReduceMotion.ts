import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** System "remove animations" setting, live. */
export function useReduceMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => live && setOn(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return on;
}
