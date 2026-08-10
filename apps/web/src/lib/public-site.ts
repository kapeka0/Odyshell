const privatePrefixes = [
  "/dashboard",
  "/sign-in",
  "/sign-up",
  "/onboarding",
  "/oauth",
  "/api",
  "/.well-known",
] as const;

export function publicSiteRequestDecision(
  enabled: boolean,
  pathname: string,
): "allow" | "not_found" {
  if (!enabled) return "allow";
  if (pathname === "/api/search") return "allow";
  return privatePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
    ? "not_found"
    : "allow";
}
