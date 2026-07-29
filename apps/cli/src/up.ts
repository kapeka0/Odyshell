import { ExpectedError } from "./errors.js";

export function assertClientUpConfiguration(options: {
  configExists: boolean;
  enrollmentRequested: boolean;
  configPath: string;
}): void {
  if (!options.configExists || !options.enrollmentRequested) return;

  throw new ExpectedError(
    `Client configuration already exists at ${options.configPath}. Refusing to ignore or overwrite enrollment options. Use a different path with "--config <path>" to enroll another Client, or run "ods up --config ${options.configPath}" without enrollment options to start this identity.`,
    "client_already_enrolled",
  );
}
