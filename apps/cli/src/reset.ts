import { removeAllClientProfiles } from "@odyshell/client";
import {
  loadStoredConfig,
  removeStoredConfig,
  type StoredConfig,
} from "./config.js";

export type ResetLocalOdyshellOptions = {
  configPath: string;
  removeProfiles?: typeof removeAllClientProfiles;
  revokeCli?: (
    config: StoredConfig & { cliToken: string },
  ) => Promise<boolean>;
};

export async function resetLocalOdyshell(
  options: ResetLocalOdyshellOptions,
): Promise<{
  loggedOut: true;
  revocationAttempted: boolean;
  revoked: boolean;
  removedProfiles: string[];
}> {
  const stored = await loadStoredConfig(options.configPath);
  const profiles = await (options.removeProfiles ?? removeAllClientProfiles)();
  let revoked = false;
  if (stored?.cliToken && options.revokeCli) {
    revoked = await options
      .revokeCli({ ...stored, cliToken: stored.cliToken })
      .catch(() => false);
  }
  await removeStoredConfig(options.configPath);
  return {
    loggedOut: true,
    revocationAttempted: Boolean(stored?.cliToken),
    revoked,
    removedProfiles: profiles.removed.map((profile) => profile.profileName),
  };
}
