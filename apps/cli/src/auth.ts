import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { ExpectedError } from "./errors.js";

type OAuthMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
};

type StoredAuthentication = {
  version: 1;
  serverUrl: string;
  clientId: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

const CLI_SCOPES = "openid profile email offline_access odyshell:agent odyshell:cli";

export function cliAuthenticationPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return join(environment.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Odyshell", "cli-auth.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Odyshell", "cli-auth.json");
  }
  return join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "odyshell", "cli-auth.json");
}

export async function login(serverUrl: string): Promise<{ serverUrl: string; expiresAt: number }> {
  const server = normalizedServerUrl(serverUrl);
  const protectedResource = await getJson<{ authorization_servers?: string[] }>(
    new URL("/.well-known/oauth-protected-resource", server).href,
  );
  const issuer = protectedResource.authorization_servers?.[0];
  if (!issuer) throw new ExpectedError("The Server does not advertise an OAuth issuer.", "oauth_metadata_missing");
  const metadata = await discoverOAuthMetadata(issuer);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const callback = await createOAuthCallback(state);

  try {
    const registration = await postJson<{ client_id?: string }>(metadata.registration_endpoint, {
      client_name: "Odyshell CLI",
      client_uri: "https://odyshell.com/docs/cli",
      redirect_uris: [callback.redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: CLI_SCOPES,
      type: "native",
      require_pkce: true,
    });
    if (!registration.client_id) throw new ExpectedError("OAuth client registration failed.", "oauth_registration_failed");
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: callback.redirectUri,
      scope: CLI_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: server,
    }).toString();
    openBrowser(authorizationUrl.href);
    const code = await callback.code;
    const tokens = await tokenRequest(metadata.token_endpoint, {
      grant_type: "authorization_code",
      client_id: registration.client_id,
      redirect_uri: callback.redirectUri,
      code,
      code_verifier: verifier,
      resource: server,
    });
    const authentication: StoredAuthentication = {
      version: 1,
      serverUrl: server,
      clientId: registration.client_id,
      tokenEndpoint: metadata.token_endpoint,
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      expiresAt: Date.now() + Math.max(60, tokens.expires_in ?? 900) * 1_000,
    };
    await writeAuthentication(authentication);
    return { serverUrl: server, expiresAt: authentication.expiresAt };
  } finally {
    callback.close();
  }
}

export async function logout(): Promise<boolean> {
  const path = cliAuthenticationPath();
  return rm(path, { force: true }).then(() => true, () => false);
}

export async function authenticatedFetch(
  path: string,
  init: RequestInit = {},
  selectedServer?: string,
): Promise<Response> {
  const authentication = await validAuthentication(selectedServer);
  const response = await fetch(new URL(path, authentication.serverUrl), {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
      authorization: `Bearer ${authentication.accessToken}`,
    },
  });
  if (response.status === 401) {
    throw new ExpectedError("Your CLI session is no longer valid. Run ods login again.", "cli_authentication_expired");
  }
  return response;
}

async function validAuthentication(selectedServer?: string): Promise<StoredAuthentication> {
  const stored = await readAuthentication();
  if (!stored) throw new ExpectedError("Sign in first with ods login.", "cli_authentication_required");
  if (selectedServer && normalizedServerUrl(selectedServer) !== stored.serverUrl) {
    throw new ExpectedError("The selected Server differs from the signed-in Server. Run ods login again.", "cli_server_mismatch");
  }
  if (stored.expiresAt > Date.now() + 30_000) return stored;
  if (!stored.refreshToken) throw new ExpectedError("Your CLI session expired. Run ods login again.", "cli_authentication_expired");
  const tokens = await tokenRequest(stored.tokenEndpoint, {
    grant_type: "refresh_token",
    client_id: stored.clientId,
    refresh_token: stored.refreshToken,
  });
  const refreshed: StoredAuthentication = {
    ...stored,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? stored.refreshToken,
    expiresAt: Date.now() + Math.max(60, tokens.expires_in ?? 900) * 1_000,
  };
  await writeAuthentication(refreshed);
  return refreshed;
}

async function discoverOAuthMetadata(issuer: string): Promise<OAuthMetadata> {
  const base = normalizedServerUrl(issuer);
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    const response = await fetch(new URL(path, base));
    if (!response.ok) continue;
    const candidate = await response.json() as Partial<OAuthMetadata>;
    if (candidate.authorization_endpoint && candidate.token_endpoint && candidate.registration_endpoint) {
      return candidate as OAuthMetadata;
    }
  }
  throw new ExpectedError("OAuth discovery did not return the required endpoints.", "oauth_metadata_missing");
}

function createOAuthCallback(expectedState: string): Promise<{
  redirectUri: string;
  code: Promise<string>;
  close: () => void;
}>;
async function createOAuthCallback(expectedState: string) {
  let settleCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    settleCode = resolve;
    rejectCode = reject;
  });
  const httpServer = createServer((request, response) => {
    const callbackUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (callbackUrl.pathname !== "/oauth/callback") {
      response.writeHead(404).end();
      return;
    }
    const state = callbackUrl.searchParams.get("state");
    const authorizationCode = callbackUrl.searchParams.get("code");
    const oauthError = callbackUrl.searchParams.get("error");
    if (state !== expectedState || !authorizationCode || oauthError) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Odyshell sign-in failed. You can close this tab.");
      rejectCode(new ExpectedError("OAuth callback validation failed.", "oauth_callback_invalid"));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Odyshell CLI is signed in. You can close this tab.");
    settleCode(authorizationCode);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("OAuth callback listener failed");
  const timeout = setTimeout(() => rejectCode(
    new ExpectedError("OAuth sign-in timed out.", "oauth_callback_timeout"),
  ), 5 * 60_000);
  timeout.unref();
  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
    code,
    close: () => {
      clearTimeout(timeout);
      httpServer.close();
    },
  };
}

function openBrowser(url: string): void {
  const executable = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => undefined);
  child.unref();
}

async function tokenRequest(endpoint: string, parameters: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(parameters),
  });
  if (!response.ok) throw new ExpectedError("OAuth token exchange failed.", "oauth_token_failed");
  const tokens = await response.json() as Partial<TokenResponse>;
  if (!tokens.access_token) throw new ExpectedError("OAuth did not return an access token.", "oauth_token_failed");
  return tokens as TokenResponse;
}

async function readAuthentication(): Promise<StoredAuthentication | null> {
  try {
    const parsed = JSON.parse(await readFile(cliAuthenticationPath(), "utf8")) as Partial<StoredAuthentication>;
    if (parsed.version !== 1 || !parsed.serverUrl || !parsed.clientId || !parsed.tokenEndpoint ||
      !parsed.accessToken || typeof parsed.expiresAt !== "number") return null;
    return parsed as StoredAuthentication;
  } catch {
    return null;
  }
}

async function writeAuthentication(authentication: StoredAuthentication): Promise<void> {
  const path = cliAuthenticationPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(authentication, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new ExpectedError(`Request failed with HTTP ${response.status}.`, "oauth_discovery_failed");
  return await response.json() as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new ExpectedError(`OAuth registration failed with HTTP ${response.status}.`, "oauth_registration_failed");
  return await response.json() as T;
}

function normalizedServerUrl(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new ExpectedError("The Server URL is invalid.", "server_url_invalid");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.href;
}
