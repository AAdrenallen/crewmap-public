import { externalNavUrl } from '@crewmap/shared/navigation/externalNav';
import type { ExternalNavApp, ExternalNavService } from '../contracts';
import { native } from '../native';

/** Hands the trip to Waze / Google Maps via their public deep links (URLs built in shared/navigation/externalNav). */
export const androidExternalNav: ExternalNavService = {
  available: async () => native.externalNavAvailable().filter((a): a is ExternalNavApp => a === 'waze' || a === 'gmaps'),
  launch: async (app, dest, via) => native.externalNavLaunch(app, externalNavUrl(app, dest, via ?? [])),
};
