import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "apps/cli/src/auth.ts"), "utf8");

describe("CLI OAuth security properties", () => {
  it("uses a loopback callback, state, PKCE, and a public OAuth client", () => {
    expect(source).toContain('"127.0.0.1"');
    expect(source).toContain("state !== expectedState");
    expect(source).toContain('code_challenge_method: "S256"');
    expect(source).toContain('token_endpoint_auth_method: "none"');
  });

  it("keeps tokens in a user-only file and never passes them to a child process", () => {
    expect(source).toContain("mode: 0o600");
    expect(source).toContain("authorization: `Bearer ${authentication.accessToken}`");
    expect(source).not.toContain("console.log(authentication");
    expect(source).not.toContain("spawn(executable, [authentication");
  });
});
