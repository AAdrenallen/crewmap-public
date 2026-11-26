import { useEffect, useRef, useState } from 'react';

/**
 * Glides a displayed integer toward `target` (ease-out cubic) so the speedometer counts smoothly between GPS fixes
 * (~1 Hz) instead of jumping. Each new target restarts the glide from the value currently shown. The rAF loop stops
 * when the glide ends and only re-renders when the shown integer changes.
 */
export function useTweenedNumber(target: number, durationMs = 900): number {
  const [shown, setShown] = useState(Math.round(target));
  const current = useRef(target);
  const shownRef = useRef(Math.round(target));
  useEffect(() => {
    const from = current.current;
    if (Math.round(from) === Math.round(target)) {
      current.current = target;
      if (shownRef.current !== Math.round(target)) setShown((shownRef.current = Math.round(target)));
      return;
    }
    const start = Date.now();
    let raf = 0;
    const step = () => {
      const k = Math.min(1, (Date.now() - start) / durationMs);
      const e = 1 - Math.pow(1 - k, 3);
      const v = from + (target - from) * e;
      current.current = v;
      const r = Math.round(v);
      if (r !== shownRef.current) setShown((shownRef.current = r));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return shown;
}
