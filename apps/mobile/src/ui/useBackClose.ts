import { useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { useNavigation } from 'expo-router';

/** Android hardware/gesture back runs `close` only while this screen is the top focused screen. */
export function useBackClose(close: () => void): void {
  const nav = useNavigation();
  const [focused, setFocused] = useState(() => nav.isFocused());
  useEffect(() => {
    setFocused(nav.isFocused());
    const onFocus = nav.addListener('focus', () => setFocused(true));
    const onBlur = nav.addListener('blur', () => setFocused(false));
    return () => {
      onFocus();
      onBlur();
    };
  }, [nav]);
  useEffect(() => {
    if (!focused) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [focused, close]);
}
