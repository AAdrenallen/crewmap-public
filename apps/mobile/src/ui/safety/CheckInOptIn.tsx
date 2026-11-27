import { create } from 'zustand';
import { t } from '@crewmap/shared/i18n';
import { SwitchRow } from '../screens-common/Layout';
import { palette } from '../theme';

/** The choice offered when creating or joining a crew (D66). Preset on; one value shared by the create / join cards. */
export const useCheckInChoice = create<{ on: boolean; set: (on: boolean) => void }>((set) => ({ on: true, set: (on) => set({ on }) }));

/** Safety check-in switch for the create / join flows. Uncontrolled = the shared choice above. */
export function CheckInOptIn({ value, onChange, testID = 'checkin-optin' }: { value?: boolean; onChange?: (on: boolean) => void; testID?: string }) {
  const choice = useCheckInChoice();
  return <SwitchRow testID={testID} icon="shield" tint={palette.mint} label={t('checkIn.title')} value={value ?? choice.on} onChange={onChange ?? choice.set} last />;
}
