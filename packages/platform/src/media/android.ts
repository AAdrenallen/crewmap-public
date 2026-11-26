import type { MediaAction, MediaOpenResult, MediaService, NowPlaying } from '../contracts';
import { native, type NativeNowPlaying } from '../native';

const toNow = (e: NativeNowPlaying | null): NowPlaying | null =>
  e
    ? {
        pkg: e.pkg,
        app: e.app ?? null,
        title: e.title ?? null,
        artist: e.artist ?? null,
        art: e.art ?? null,
        playing: !!e.playing,
        canPrev: !!e.canPrev,
        canNext: !!e.canNext,
        canNextPlaylist: !!e.canNextPlaylist,
      }
    : null;

let watchers = 0;

/**
 * Kotlin `MediaBridge`: MediaSessionManager.getActiveSessions with the NavStatusListener component (Notification
 * Access). Session callbacks run only while someone subscribes. Track info stays in memory on this device.
 */
export const androidMedia: MediaService = {
  hasAccess: () => native.mediaHasAccess(),
  installed: () => native.mediaInstalled(),
  preferred: () => native.mediaPreferred(),
  setPreferred: (pkg) => native.mediaSetPreferred(pkg),
  current: () => toNow(native.mediaCurrent()),
  onChange: (cb) => {
    const sub = native.addListener('onMedia', (e) => cb(e.none ? null : toNow(e)));
    if (watchers++ === 0) native.mediaStart();
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      sub.remove();
      if (--watchers === 0) native.mediaStop();
    };
  },
  control: (action: MediaAction) => native.mediaControl(action),
  openSplit: async (pkg) => {
    const r = await native.mediaOpenSplit(pkg ?? null);
    return (r === 'split' || r === 'app' ? r : 'none') satisfies MediaOpenResult;
  },
};
