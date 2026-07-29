import { ExpectedError } from "./errors.js";

const units = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
} as const;

export function parseDuration(value: string, option = "duration"): number {
  const match = /^(\d+)([smhd])?$/i.exec(value.trim());
  if (!match) {
    throw new ExpectedError(
      `${option} must be a duration such as 30s, 15m, 1h, or 1d`,
      "invalid_duration",
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2]?.toLowerCase() ?? "s") as keyof typeof units;
  const seconds = amount * units[unit];
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new ExpectedError(`${option} must be greater than zero`, "invalid_duration");
  }
  return seconds;
}
