import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("self-hosted distribution", () => {
  it("keeps local identity environment files outside every Docker build context", () => {
    expect(source(".dockerignore")).toContain("**/.env*");
  });

  it("runs application services in production and fails closed on secrets", () => {
    const compose = source("docker-compose.yml");
    const example = source(".env.example");

    expect(compose.match(/NODE_ENV: production/g)).toHaveLength(2);
    expect(compose.match(/ODYSHELL_DEPLOYMENT_MODE: self-hosted/g)).toHaveLength(2);
    for (const secret of [
      "POSTGRES_PASSWORD",
      "ODYSHELL_WEB_KEY",
      "BETTER_AUTH_SECRET",
    ]) {
      expect(compose).toContain(`\${${secret}:?`);
    }
    expect(compose).toContain("ODYSHELL_BIND_ADDRESS:-127.0.0.1");
    expect(compose).toContain('ODYSHELL_IDENTITY_JWKS_ALLOW_HTTP: "true"');
    expect(compose).toContain("ODYSHELL_IDENTITY_JWKS_URL: http://web:3000/api/auth/jwks");
    expect(compose).not.toContain("ODYSHELL_ALLOW_DEV_CREDENTIALS");
    expect(compose).not.toContain("ODYSHELL_AGENT_KEY");
    expect(compose).not.toContain("dev-admin-key");
    expect(compose).not.toContain("dev-agent-key");
    expect(compose).not.toMatch(/POSTGRES_PASSWORD:\s+odyshell/u);
    for (const secret of [
      "POSTGRES_PASSWORD",
      "ODYSHELL_WEB_KEY",
      "BETTER_AUTH_SECRET",
    ]) {
      expect(example).toContain(`${secret}=\n`);
    }
    expect(example).not.toContain("replace-with");
  });

  it("builds reproducibly with the configured public Server origin", () => {
    const compose = source("docker-compose.yml");
    const serverDockerfile = source("apps/server/Dockerfile");
    const webDockerfile = source("apps/web/Dockerfile");

    expect(serverDockerfile).toContain("pnpm install --frozen-lockfile");
    expect(serverDockerfile).not.toContain("--no-frozen-lockfile");
    expect(compose).toContain("NEXT_PUBLIC_ODYSHELL_SERVER_URL:");
    expect(compose).toContain("NEXT_PUBLIC_OIDC_AUTH_ENABLED:");
    expect(webDockerfile).toContain("ARG NEXT_PUBLIC_ODYSHELL_SERVER_URL");
    expect(webDockerfile).toContain("ARG NEXT_PUBLIC_OIDC_AUTH_ENABLED");
    expect(webDockerfile).toContain(
      "NEXT_PUBLIC_ODYSHELL_SERVER_URL=$NEXT_PUBLIC_ODYSHELL_SERVER_URL",
    );
  });

  it("does not require hosted analytics, avatars, or identity", () => {
    const webPackage = source("apps/web/package.json");
    const layout = source("apps/web/src/app/layout.tsx");
    const avatars = source("apps/web/src/components/identity-avatar.tsx");
    const auth = source("apps/web/src/lib/identity-auth.ts");

    expect(webPackage).not.toContain("@vercel/analytics");
    expect(webPackage).not.toContain("@xyflow/react");
    expect(layout).not.toContain("<Analytics");
    expect(avatars).toContain("facehashAvatarPath(identity)");
    expect(avatars).not.toContain("avatar.vercel.sh");
    expect(auth).toContain("emailAndPassword:");
    expect(auth).toContain('deploymentMode === "cloud"');
    expect(auth).toContain("select exists(select 1 from organization)");
  });

  it("smokes identity and denial boundaries instead of health alone", () => {
    const smoke = source("scripts/self-host-smoke.mjs");

    expect(smoke).toContain("/api/auth/sign-up/email");
    expect(smoke).toContain("/api/auth/organization/create");
    expect(smoke).toContain("/api/auth/organization/set-active");
    expect(smoke).toContain("/api/dashboard/context");
    expect(smoke).toContain("Unauthenticated MCP denial");
    expect(smoke).toContain("Second Organization denial");
    expect(smoke).not.toContain("console.log(body)");
  });
});
