/**
 * Hazard config spread over P2P as a message signed by the circle owner's device key (the router already verifies
 * membership; this adds an owner-only signature so a regular member can't flip it). Verification is injected so this
 * package stays free of crypto dependencies.
 */
export interface HazardConfig {
  /** Owner kill switch for the Waze Live Map adapter (D62). */
  wazeEnabled: boolean;
  paidEnabled: boolean;
  /** Monotonic version (owner's clock ms); higher wins. */
  version: number;
}

export interface SignedHazardConfig {
  config: HazardConfig;
  /** Owner device id and signature (b64) over canonical JSON of `config`. */
  by: string;
  sig: string;
}

export const DEFAULT_HAZARD_CONFIG: HazardConfig = { wazeEnabled: true, paidEnabled: false, version: 0 };

export function canonicalConfig(c: HazardConfig): string {
  return JSON.stringify({ paidEnabled: c.paidEnabled, version: c.version, wazeEnabled: c.wazeEnabled });
}

/**
 * Apply an incoming signed config if it's from the owner, the signature verifies, and it's newer.
 * Returns the config now in force.
 */
export function applySignedConfig(
  current: HazardConfig,
  incoming: SignedHazardConfig,
  ownerId: string,
  verify: (message: string, sig: string, signerId: string) => boolean,
): HazardConfig {
  if (incoming.by !== ownerId) return current;
  if (!verify(canonicalConfig(incoming.config), incoming.sig, incoming.by)) return current;
  if (incoming.config.version <= current.version) return current;
  return { ...incoming.config };
}
