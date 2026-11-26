import { useEffect } from 'react';
import { BackHandler } from 'react-native';

/** Android hardware back runs `close` (sheet-style screens). */
export function useBackClose(close: () => void): void {
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  });
}
