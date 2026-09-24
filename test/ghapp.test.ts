import { afterEach, describe, expect, it, vi } from "vitest";
import { appJwt, generateTestKeyPair, installationToken, resolveAuthToken, loadAppCredentials } from "../src/pr/ghapp.js";
import type { Config } from "../src/config.js";

const { privateKey } = generateTestKeyPair();
const creds = { appId: "12345", installationId: "67890", privateKey };

describe("GitHub App auth (v0.6)", () => {
  it("issues an RS256 JWT with the right claims shape", () => {
    const jwt = appJwt(creds);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe("12345");
    expect(payload.exp - payload.iat).toBe(660); // -60 skew + 600s ttl
  });

  it("exchanges the JWT for an installation token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token: "ghs_installation_token" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const token = await installationToken(creds, "https://api.github.com");
    expect(token).toBe("ghs_installation_token");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/app/installations/67890/access_tokens");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer ey/);
  });

  it("surfaces token-exchange failures with the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(installationToken(creds, "https://api.github.com")).rejects.toThrow(/401/);
  });

  it("falls back to PAT when app env is absent, prefers app when present", async () => {
    const config = { githubToken: "ghp_pat" } as Config;
    const prev = { ...process.env };
    delete process.env.PGHEAL_GITHUB_APP_ID;
    delete process.env.PGHEAL_GITHUB_APP_INSTALLATION_ID;
    delete process.env.PGHEAL_GITHUB_APP_KEY_PATH;
    const pat = await resolveAuthToken(config);
    expect(pat.mode).toBe("pat");

    process.env.PGHEAL_GITHUB_APP_ID = "1";
    process.env.PGHEAL_GITHUB_APP_INSTALLATION_ID = "2";
    // real key file on disk (ESM readFile mock is unreliable across loaders)
    const { writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const keyPath = path.join(os.tmpdir(), `pgheal-test-key-${Date.now()}.pem`);
    await writeFile(keyPath, privateKey, "utf8");
    process.env.PGHEAL_GITHUB_APP_KEY_PATH = keyPath;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token: "ghs_x" }), { status: 201 })));
    const app = await resolveAuthToken(config);
    expect(app.mode).toBe("github-app");
    expect(app.token).toBe("ghs_x");

    process.env = prev;
    vi.restoreAllMocks();
  });

  it("loadAppCredentials returns null without env", async () => {
    const prev = { ...process.env };
    delete process.env.PGHEAL_GITHUB_APP_ID;
    expect(await loadAppCredentials({} as Config)).toBeNull();
    process.env = prev;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
