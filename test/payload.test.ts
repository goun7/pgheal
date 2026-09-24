import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPayload, enrichPrBody } from "../src/pr/github.js";
import type { MigrationFile } from "../src/types.js";

const migration: MigrationFile = {
  dialect: "sql",
  path: "migrations/20260923_idx_orders_user_id.sql",
  content: "CREATE CONCURRENTLY INDEX IF NOT EXISTS idx_orders_user_id ON \"orders\" (\"user_id\");\n",
};

const sim = { candidate: { table: "orders", columns: ["user_id"], method: "btree" }, speedup: 12.5 };

const rec = () => ({ migration, simulation: sim });

describe("buildPayload", () => {
  it("deterministic branch name from content fingerprint", async () => {
    const a = await buildPayload([rec()], [], { repo: "acme/api", dialect: "sql" });
    const b = await buildPayload([rec()], [], { repo: "acme/api", dialect: "sql" });
    expect(a.branch).toBe(b.branch);
    expect(a.branch).toMatch(/^pgheal\/index-[0-9a-z]+$/);
  });

  it("different content → different branch", async () => {
    const a = await buildPayload([rec()], [], { repo: "acme/api", dialect: "sql" });
    const b = await buildPayload(
      [{ migration: { ...migration, content: migration.content + "-- x\n" }, simulation: sim }],
      [],
      { repo: "acme/api", dialect: "sql" },
    );
    expect(a.branch).not.toBe(b.branch);
  });

  it("includes cleanup table and DROP warning", async () => {
    const p = await buildPayload(
      [rec()],
      [{ index: { name: "dead_idx", table: "orders", sizeBytes: 4096, reason: "unused" } }],
      { repo: "acme/api", dialect: "sql" },
    );
    expect(p.body).toContain("dead_idx");
    expect(p.body).toContain("30-day observation window");
  });

  it("title mentions proven indexes", async () => {
    const p = await buildPayload([rec()], [], { repo: "acme/api", dialect: "sql" });
    expect(p.title).toMatch(/perf\(db\): add 1 proven PostgreSQL index/);
  });
});

describe("enrichPrBody (LLM PR summary)", () => {
  const cfg = { llmApiUrl: "http://127.0.0.1:9/v1/chat/completions", llmApiKey: "sk-test", llmModel: "test-model" };
  const added = [{ table: "orders", columns: ["user_id"], method: "btree", speedup: 12.5 }];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns deterministic body when no LLM env is set", async () => {
    const p = await buildPayload([rec()], [], { repo: "acme/api", dialect: "sql" });
    const out = await enrichPrBody(p.body, {}, added, [], "sql");
    expect(out).toBe(p.body);
  });

  it("inserts AI summary after the zero-exfiltration preamble when endpoint answers", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Adds idx_orders_user_id on orders; HypoPG shows ~12.5x." } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = await buildPayload([rec()], [], { repo: "acme/api", dialect: "sql" });
    const out = await enrichPrBody(p.body, cfg, added, [], "sql");
    expect(out).toContain("AI summary");
    expect(out).toContain("idx_orders_user_id on orders; HypoPG shows ~12.5x.");
    // deterministic proof body preserved verbatim after the AI block
    const marker = "hypothetical indexes.\n";
    expect(out.endsWith(p.body.slice(p.body.indexOf(marker) + marker.length))).toBe(true);
    // model + facts were sent
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.model).toBe("test-model");
    expect(JSON.parse(body.messages[1].content).added[0].speedup).toBe(12.5);
  });

  it("falls back to the deterministic body when the endpoint errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const p = await buildPayload([rec()], [], { repo: "acme/api", dialect: "sql" });
    const out = await enrichPrBody(p.body, cfg, added, [], "sql");
    expect(out).toBe(p.body);
  });

  it("falls back when the model returns a too-short summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })),
    );
    const p = await buildPayload([rec()], [], { repo: "acme/api", dialect: "sql" });
    const out = await enrichPrBody(p.body, cfg, added, [], "sql");
    expect(out).toBe(p.body);
  });
});
