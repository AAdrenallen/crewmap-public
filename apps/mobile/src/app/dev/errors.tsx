import { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { clearErrors, dumpErrors } from '../../core/errorLog';

/**
 * Deep link for tools/device/collect-errors.sh: crewmap://dev/errors?action=dump|clear.
 * Prints the scrubbed log to logcat (or clears it), then returns home. Renders nothing.
 */
export default function DevErrors() {
  const { action } = useLocalSearchParams<{ action?: string }>();
  const router = useRouter();
  useEffect(() => {
    if (action === 'clear') clearErrors();
    else dumpErrors();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [action, router]);
  return null;
}
