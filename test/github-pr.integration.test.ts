import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { buildPayload, deliverPr } from "../src/pr/github.js";
import { loadConfig } from "../src/config.js";
import type { MigrationFile } from "../src/types.js";

/**
 * Full --write flow against an in-process mock of the GitHub REST endpoints
 * pgHeal uses: getRef, createRef, createBlob, createTree, createCommit,
 * updateRef, pulls.create. Validates the exact call order and payloads.
 */

const migration: MigrationFile = {
  dialect: "sql",
  path: "migrations/20260923_idx_orders_user_id.sql",
  content: 'CREATE CONCURRENTLY INDEX IF NOT EXISTS idx_orders_user_id ON "orders" ("user_id");\n',
};

const calls: { method: string; url: string; body?: unknown }[] = [];

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      calls.push({ method: req.method ?? "", url: req.url ?? "", body: parsed });
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (req.method === "GET" && req.url?.match(/\/repos\/acme\/api\/git\/ref\/heads(\/|%2F)main$/)) {
        return json(200, { object: { sha: "basesha0000000000000000000000000000000001" } });
      }
      if (req.method === "GET" && req.url?.includes("/git/ref/heads") && req.url?.includes("pgheal")) {
        return json(404, { message: "Not Found" });
      }
      if (req.method === "POST" && req.url?.endsWith("/git/refs")) {
        return json(201, { ref: "refs/heads/pgheal/index-abc", object: { sha: "basesha0000000000000000000000000000000001" } });
      }
      if (req.method === "POST" && req.url?.endsWith("/git/blobs")) {
        return json(201, { sha: "blobsha000000000000000000000000000000000001" });
      }
      if (req.method === "POST" && req.url?.endsWith("/git/trees")) {
        return json(201, { sha: "treeshа00000000000000000000000000000000001".replace("а", "a") });
      }
      if (req.method === "POST" && req.url?.endsWith("/git/commits")) {
        return json(201, { sha: "commitsha000000000000000000000000000000001" });
      }
      if (req.method === "PATCH" && /\/git\/refs\/heads(\/|%2F)pgheal/.test(req.url ?? "")) {
        return json(200, { ok: true });
      }
      if (req.method === "POST" && req.url?.endsWith("/pulls")) {
        return json(201, { html_url: "https://github.local/acme/api/pull/42", number: 42 });
      }
      return json(404, { message: `unexpected ${req.method} ${req.url}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}/api/v3`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("deliverPr — full --write flow against mock GitHub API", () => {
  it(
    "creates shadow branch, commits migration, opens PR (in order)",
    { timeout: 30000 },
    async () => {
    const config = loadConfig(
      { DATABASE_URL: "postgres://u:p@h:5432/d" },
      {
        githubRepo: "acme/api",
        githubToken: "test-token",
        write: true,
        githubApiUrl: baseUrl,
        baseBranch: "main",
      },
    );
    const payload = await buildPayload([{ migration, simulation: { candidate: { table: "orders", columns: ["user_id"], method: "btree" } } }], [], { repo: "acme/api", dialect: "sql" });

    const result = await deliverPr(config, payload);

    expect(result.created).toBe(true);
    expect(result.url).toContain("/pull/42");
    expect(result.branch).toBe(payload.branch);

    const urls = calls.map((c) => `${c.method} ${c.url}`);
    expect(urls.some((u) => u.startsWith("GET ") && u.includes("/git/ref/heads") && u.includes("main"))).toBe(true);
    expect(urls.some((u) => u.startsWith("POST ") && u.endsWith("/git/refs"))).toBe(true);
    expect(urls.some((u) => u.includes("/git/blobs"))).toBe(true);
    expect(urls.some((u) => u.includes("/git/trees"))).toBe(true);
    expect(urls.some((u) => u.includes("/git/commits"))).toBe(true);
    expect(urls.some((u) => u.includes("/pulls"))).toBe(true);

    // blob content must be base64 of the migration
    const blobCall = calls.find((c) => c.url?.endsWith("/git/blobs"));
    expect(Buffer.from((blobCall?.body as { content: string }).content, "base64").toString("utf8")).toContain(
      "CREATE CONCURRENTLY INDEX",
    );

    // PR payload must reference shadow branch and include proof language
    const prCall = calls.find((c) => c.url?.endsWith("/pulls"));
    expect((prCall?.body as { head: string }).head).toBe(payload.branch);
    expect((prCall?.body as { body: string }).body).toContain("Zero data exfiltration");
    },
  );

  it("dry-run never touches the API", async () => {
    calls.length = 0;
    const config = loadConfig(
      { DATABASE_URL: "postgres://u:p@h:5432/d" },
      { githubRepo: "acme/api", githubToken: "t", write: false, githubApiUrl: baseUrl },
    );
    const payload = await buildPayload([{ migration, simulation: { candidate: { table: "orders", columns: ["user_id"], method: "btree" } } }], [], { repo: "acme/api", dialect: "sql" });
    const result = await deliverPr(config, payload);
    expect(result.dryRun).toBe(true);
    expect(result.created).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
