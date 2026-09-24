import { createSign, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Config } from "../config.js";

/**
 * GitHub App authentication — the "no long-lived token" tier (v0.6).
 *
 * A GitHub App issues a 10-minute RS256 JWT (signed with the app's private
 * key), which is exchanged for a 1-hour installation token. pgHeal never
 * stores a persistent PAT: the private key stays on disk (path-only in env),
 * tokens live for minutes and are never logged. Falls back to GITHUB_TOKEN
 * when no app config is present, so existing setups keep working.
 */

export interface GhAppCredentials {
  appId: string;
  installationId: string;
  privateKey: string;
}

export async function loadAppCredentials(_config?: Config): Promise<GhAppCredentials | null> {
  void _config; // reserved for per-repo app scoping
  const appId = process.env.PGHEAL_GITHUB_APP_ID;
  const installationId = process.env.PGHEAL_GITHUB_APP_INSTALLATION_ID;
  const keyPath = process.env.PGHEAL_GITHUB_APP_KEY_PATH;
  if (!appId || !installationId || !keyPath) return null; // PAT mode
  const privateKey = await readFile(keyPath, "utf8");
  return { appId, installationId, privateKey };
}

/** Base64url JWT signed RS256, exp 10 min, iss = appId. */
export function appJwt(credentials: GhAppCredentials, now = Math.floor(Date.now() / 1000)): string {
  const b64url = (buf: Buffer | string): string =>
    Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: credentials.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = b64url(signer.sign(credentials.privateKey));
  return `${header}.${payload}.${signature}`;
}

/** Exchange the JWT for a 1-hour installation access token. */
export async function installationToken(
  credentials: GhAppCredentials,
  githubApiUrl = "https://api.github.com",
): Promise<string> {
  const res = await fetch(`${githubApiUrl}/app/installations/${credentials.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${appJwt(credentials)}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub App token exchange failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 200));
  }
  const out = (await res.json()) as { token?: string };
  if (!out.token) throw new Error("GitHub App token exchange returned no token");
  return out.token;
}

/**
 * Resolve the auth token for PR delivery: GitHub App installation token when
 * configured, otherwise the PAT from config. App mode wins when both exist.
 */
export async function resolveAuthToken(config: Config): Promise<{ token: string; mode: "github-app" | "pat" }> {
  const creds = await loadAppCredentials(config);
  if (creds) {
    const token = await installationToken(creds, config.githubApiUrl ?? "https://api.github.com");
    return { token, mode: "github-app" };
  }
  return { token: config.githubToken!, mode: "pat" };
}

/** Dev/test helper: generate a throwaway RSA keypair in PEM form. */
export function generateTestKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
}
