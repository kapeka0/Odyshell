export function cloudRouteIdentityDecision(
  userId: string | null | undefined,
  organizationId: string | null | undefined,
): "authorized" | "not_authenticated" | "organization_required" {
  if (!userId) return "not_authenticated";
  if (!organizationId) return "organization_required";
  return "authorized";
}
