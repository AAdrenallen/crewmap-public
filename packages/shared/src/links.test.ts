import { describe, expect, it } from 'vitest';
import { DOWNLOAD_URL, extractInviteLink, inviteRoute, JOIN_PAGE_URL, REPO_URL, toShareLink } from './links';
import { en } from './i18n/en';
import { fr } from './i18n/fr';
import { ru } from './i18n/ru';

const fill = (s: string, p: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => p[k] ?? '');

describe('URLs', () => {
  it('download is the rolling preview APK on the public repo', () => {
    expect(REPO_URL).toBe('https://github.com/AAdrenallen/crewmap-public');
    expect(DOWNLOAD_URL).toBe('https://github.com/AAdrenallen/crewmap-public/releases/download/preview/CrewMap-Preview.apk');
  });
  it('join page is the public Pages site', () => expect(JOIN_PAGE_URL).toBe('https://aadrenallen.github.io/crewmap-public/join/'));
});

describe('extractInviteLink', () => {
  const token = 'AbC-123_xyz';
  const link = `crewmap://join#${token}`;
  const https = `https://aadrenallen.github.io/crewmap-public/join/#${token}`;
  it('returns a bare link', () => expect(extractInviteLink(link)).toBe(link));
  it('normalises the https form to the internal link', () => {
    expect(extractInviteLink(https)).toBe(link);
    expect(extractInviteLink(`https://aadrenallen.github.io/crewmap-public/join#${token}`)).toBe(link);
    expect(extractInviteLink(`https://aadrenallen.github.io/crewmap-public/join/index.html#${token}`)).toBe(link);
    expect(extractInviteLink(`HTTPS://AAdrenallen.github.io/crewmap-public/join/#${token}`)).toBe(link);
  });
  it('keeps the token case', () => expect(extractInviteLink('crewmap://join#aBcD')).toBe('crewmap://join#aBcD'));
  it('trims whitespace and surrounding text', () => {
    expect(extractInviteLink(`  hi\n${link}\n`)).toBe(link);
    expect(extractInviteLink(`Join X on CrewMap\n${https}\n`)).toBe(link);
  });
  it('strips trailing punctuation', () => {
    expect(extractInviteLink(`tap ${link}.`)).toBe(link);
    expect(extractInviteLink(`(${link})`)).toBe(link);
    expect(extractInviteLink(`«${https}»`)).toBe(link);
  });
  it('returns null without a link', () => {
    expect(extractInviteLink('hello https://example.com')).toBeNull();
    expect(extractInviteLink('https://aadrenallen.github.io/crewmap-public/join/')).toBeNull();
    expect(extractInviteLink('https://example.com/crewmap-public/join/#abc')).toBeNull();
    expect(extractInviteLink('')).toBeNull();
  });
  it('takes the first of several links', () => expect(extractInviteLink(`${link} crewmap://join#other`)).toBe(link));
});

describe('toShareLink / inviteRoute', () => {
  const link = 'crewmap://join#tok_1-2';
  it('round-trips between the two forms', () => {
    expect(toShareLink(link)).toBe('https://aadrenallen.github.io/crewmap-public/join/#tok_1-2');
    expect(extractInviteLink(toShareLink(link))).toBe(link);
    expect(toShareLink(toShareLink(link))).toBe(toShareLink(link));
  });
  it('routes either form to the join screen, other URLs unchanged', () => {
    const to = `/join?link=${encodeURIComponent(link)}`;
    expect(inviteRoute(link)).toBe(to);
    expect(inviteRoute(toShareLink(link))).toBe(to);
    expect(inviteRoute('crewmap://dev/errors?action=dump')).toBe('crewmap://dev/errors?action=dump');
    expect(inviteRoute('/friend/abc')).toBe('/friend/abc');
  });
});

describe('share message', () => {
  const link = 'crewmap://join#tok';
  for (const [lang, d] of [['en', en], ['fr', fr], ['ru', ru]] as const) {
    it(`${lang}: crew name + the https link only, and it parses back`, () => {
      const msg = fill(d['circle.shareMessage'], { name: 'Crew', link: toShareLink(link) });
      expect(msg).toContain('Crew');
      expect(msg.split('\n')).toHaveLength(2);
      expect(msg.split('\n')[1]).toBe(toShareLink(link));
      expect(msg).not.toContain('crewmap://');
      expect(extractInviteLink(msg)).toBe(link);
    });
  }
});
