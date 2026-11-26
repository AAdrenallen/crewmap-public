/** Public repo (never the private one). */
export const REPO_URL = 'https://github.com/AAdrenallen/crewmap-public';

/** Rolling preview APK: the `preview` release's asset is replaced on every publish (tools/release/publish-preview.sh), so this is always the newest build. */
export const DOWNLOAD_URL = `${REPO_URL}/releases/download/preview/CrewMap-Preview.apk`;

/** Static join page (GitHub Pages, `site/join/index.html`). The invite rides in the fragment, which browsers never send to a server. */
export const JOIN_PAGE_URL = 'https://aadrenallen.github.io/crewmap-public/join/';

/** Internal invite form, what the protocol encodes and `decodeInvite` reads. */
export const INVITE_PREFIX = 'crewmap://join#';

/** `crewmap://join#<token>` or `https://aadrenallen.github.io/crewmap-public/join/#<token>`; the token is base64url. */
const INVITE_RE = /(?:crewmap:\/\/join\/?|https?:\/\/aadrenallen\.github\.io\/crewmap-public\/join(?:\/(?:index\.html)?)?)#([A-Za-z0-9_-]+)/i;

/** Finds the first invite (either form) in arbitrary text (chat message, clipboard, QR) and returns it as `crewmap://join#<token>`. Null when absent. */
export function extractInviteLink(text: string): string | null {
  const m = INVITE_RE.exec(text);
  return m ? INVITE_PREFIX + m[1]! : null;
}

/** The https form people share: opens the join page (install + open the app), or the app directly. */
export function toShareLink(link: string): string {
  const internal = extractInviteLink(link);
  return internal ? JOIN_PAGE_URL + internal.slice(INVITE_PREFIX.length - 1) : link;
}

/**
 * Expo Router `+native-intent` rewrite: any invite URL (either form) → the join screen with the normalised link.
 * Other URLs pass through untouched.
 */
export function inviteRoute(url: string): string {
  const m = INVITE_RE.exec(url.trim());
  return m && m.index === 0 ? `/join?link=${encodeURIComponent(INVITE_PREFIX + m[1]!)}` : url;
}
