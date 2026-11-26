import { t } from '@crewmap/shared/i18n';

/** Turns the protocol's join errors into a sentence a person can act on. */
export function inviteErrorMessage(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (m.includes('wrong code') || m.includes('bad code')) return t('code.wrong');
  if (m.includes('code locked')) return t('code.locked');
  if (m.includes('too many codes')) return t('code.tooMany');
  if (m.includes('expired')) return t('invite.expired');
  if (m.includes('no answer') || m.includes('already used')) return t('invite.noAnswer');
  if (m.includes('not a crewmap') || m.includes('malformed')) return t('invite.invalid');
  return t('invite.failed');
}

import { kvGet, kvSet } from './db';
import { createInviteStash } from './inviteStash';

/** Join link received before onboarding; persisted so it survives onboarding and a restart. */
export const inviteStash = createInviteStash({
  read: () => kvGet<string | null>('pendingInvite', null),
  write: (l) => kvSet('pendingInvite', l),
});
