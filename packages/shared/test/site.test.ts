import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DOWNLOAD_URL, JOIN_PAGE_URL, REPO_URL, extractInviteLink } from '../src/links';

const SITE = resolve(__dirname, '../../../site');
const html = readFileSync(resolve(SITE, 'join/index.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;

/** Runs the page script against a minimal fake DOM; records navigations and clipboard writes. */
function run(hash: string, opts: { ua?: string; search?: string; lang?: string } = {}) {
  const els: Record<string, { textContent: string; hidden: boolean; href: string; onclick?: () => void }> = {};
  for (const id of ['name', 'get', 'open', 'hint']) els[id] = { textContent: '', hidden: id === 'name' || id === 'open', href: '' };
  const copied: string[] = [];
  const page = new URL(JOIN_PAGE_URL);
  const location = { hash, search: opts.search ?? '', origin: page.origin, pathname: page.pathname, href: page.href + (opts.search ?? '') + hash };
  const startHref = location.href;
  runInNewContext(script, {
    location,
    navigator: { userAgent: opts.ua ?? 'Mozilla/5.0 (Linux; Android 14)', language: opts.lang ?? 'en-GB', clipboard: { writeText: async (s: string) => void copied.push(s) } },
    document: { getElementById: (id: string) => els[id], documentElement: { lang: '' } },
    atob,
    TextDecoder,
    Uint8Array,
    JSON,
    String,
    encodeURIComponent,
  });
  return { els, copied, navigated: location.href !== startHref ? location.href : null };
}

const token = Buffer.from(JSON.stringify({ v: 1, n: 'Night Riders', c: 'c', i: 'i', k: 'k', b: 'b', s: 's', e: 1, r: [] })).toString('base64url');

describe('join page (site/join/index.html)', () => {
  it('links the install button to the rolling preview APK', () => {
    expect(html).toContain(`href="${DOWNLOAD_URL}"`);
  });

  it('loads and fetches nothing: no external scripts, styles, fonts, images or requests', () => {
    expect(html).not.toMatch(/fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|new Image|<img|<iframe|<link|@import|url\(|<script[^>]*\ssrc=/i);
    expect(html).toContain(`default-src 'none'`);
    expect(html).toContain('no-referrer');
    const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    expect(urls.every((u) => u === DOWNLOAD_URL || u.startsWith(REPO_URL))).toBe(true);
  });

  it('stays tiny', () => expect(Buffer.byteLength(html)).toBeLessThan(8 * 1024));

  it('opens the app via an intent URL that keeps the token in the fragment, with a no-loop fallback', () => {
    const r = run(`#${token}`);
    expect(r.navigated).toBe(r.els.open!.href);
    expect(r.els.open!.hidden).toBe(false);
    const intent = r.navigated!;
    expect(intent.startsWith(`intent://join#${token}#Intent;scheme=crewmap;package=app.crewmap.preview;`)).toBe(true);
    expect(intent.endsWith(';end')).toBe(true);
    const fb = decodeURIComponent(/S\.browser_fallback_url=([^;]+)/.exec(intent)![1]!);
    expect(fb).toBe(`${JOIN_PAGE_URL}?o=1#${token}`);
    expect(run(`#${token}`, { search: '?o=1' }).navigated).toBeNull();
  });

  it('shows the crew name decoded locally', () => expect(run(`#${token}`).els.name).toMatchObject({ textContent: 'Night Riders', hidden: false }));

  it('copies the https invite on Install so the app can pick it up', async () => {
    const r = run(`#${token}`);
    r.els.get!.onclick!();
    await Promise.resolve();
    expect(r.copied).toEqual([JOIN_PAGE_URL + '#' + token]);
    expect(extractInviteLink(r.copied[0]!)).toBe(`crewmap://join#${token}`);
  });

  it('without a token or off Android: install only, no navigation', () => {
    const none = run('');
    expect(none.navigated).toBeNull();
    expect(none.els.get!.onclick).toBeUndefined();
    expect(none.els.open!.hidden).toBe(true);
    const desktop = run(`#${token}`, { ua: 'Mozilla/5.0 (Windows NT 10.0)' });
    expect(desktop.navigated).toBeNull();
    expect(desktop.els.open!.hidden).toBe(true);
  });

  it('speaks fr and ru', () => {
    expect(run('', { lang: 'fr-FR' }).els.get!.textContent).toBe('Installer CrewMap');
    expect(run('', { lang: 'ru' }).els.get!.textContent).toBe('Установить CrewMap');
  });

  it('ships assetlinks for the preview package and .nojekyll so Pages serves .well-known', () => {
    const al = JSON.parse(readFileSync(resolve(SITE, '.well-known/assetlinks.json'), 'utf8')) as Array<{ target: { package_name: string; sha256_cert_fingerprints: string[] } }>;
    expect(al[0]!.target.package_name).toBe('app.crewmap.preview');
    expect(al[0]!.target.sha256_cert_fingerprints[0]).toMatch(/^FA:C6:17:45:DC:09/);
    expect(readFileSync(resolve(SITE, '.nojekyll'), 'utf8')).toBe('');
  });
});
