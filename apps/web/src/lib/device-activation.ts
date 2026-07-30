import { z } from "zod";

export const deviceCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase().replaceAll("-", ""))
  .pipe(
    z
      .string()
      .regex(
        /^[A-HJ-NP-Z2-9]{8}$/,
        "Enter the 8-character code shown by ods",
      ),
  );

export const deviceApprovalReasonSchema = z.enum([
  "device_code_not_found",
  "device_code_expired",
  "device_code_already_used",
  "organization_admin_required",
  "organization_required",
  "not_authenticated",
  "approval_failed",
]);

export type DeviceApprovalReason = z.infer<
  typeof deviceApprovalReasonSchema
>;

export function deviceApprovalReason(value: unknown): DeviceApprovalReason {
  const parsed = deviceApprovalReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : "approval_failed";
}

export function deviceApprovalErrorPath(value: unknown): string {
  return `/activate/error?reason=${encodeURIComponent(deviceApprovalReason(value))}`;
}

export function deviceApprovalMessage(reason: DeviceApprovalReason): string {
  switch (reason) {
    case "device_code_not_found":
      return "This code does not exist. Check the terminal and try again.";
    case "device_code_expired":
      return "This code expired. Run ods login again to create a new one.";
    case "device_code_already_used":
      return "This code was already used. Run ods login again if the terminal did not finish.";
    case "organization_admin_required":
      return "Only an organization administrator can approve CLI access.";
    case "organization_required":
      return "Select a workspace before approving this CLI.";
    case "not_authenticated":
      return "Your sign-in expired before the CLI could be approved.";
    case "approval_failed":
      return "Odyshell could not approve this CLI. No credential was issued.";
  }
}
