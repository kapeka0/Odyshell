import { removeAllClientProfiles } from "@odyshell/client";

export type ResetLocalOdyshellOptions = {
  removeProfiles?: typeof removeAllClientProfiles;
};

export async function resetLocalOdyshell(
  options: ResetLocalOdyshellOptions = {},
): Promise<{
  removedProfiles: string[];
}> {
  const profiles = await (options.removeProfiles ?? removeAllClientProfiles)();
  return {
    removedProfiles: profiles.removed.map((profile) => profile.profileName),
  };
}
