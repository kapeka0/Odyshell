const publicPaths = new Set([
  "/",
  "/api/search",
  "/docs.md",
  "/llms-full.txt",
  "/llms.txt",
  "/robots.txt",
]);
const publicPrefixes = [
  "/docs",
  "/llms.mdx/docs",
] as const;

export function publicSiteEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.VERCEL === "1" || environment.ODYSHELL_PUBLIC_SITE === "true";
}

export function publicSiteRequestDecision(
  enabled: boolean,
  pathname: string,
): "allow" | "not_found" {
  if (!enabled) return "allow";
  if (publicPaths.has(pathname)) return "allow";
  return publicPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
    ? "allow"
    : "not_found";
}
