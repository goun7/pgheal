import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlackMessage, sendSlackNotification, summarize } from "../src/notify/slack.js";
import type { ScanResult } from "../src/types.js";

const scan = (over: Partial<ScanResult> = {}): ScanResult =>
  ({
    db: { serverVersion: "PG 18", database: "demo", hypopg: true, pgss: true },
    candidates: [],
    recommendations: [
      {
        simulation: {
          candidate: { table: "orders", columns: ["user_id"], method: "btree", isUnique: false, fromQueryid: "q", reason: "r" },
          before: { nodeType: "Seq Scan", totalCost: 100, planRows: 10, usesIndexScan: false, raw: {} },
          after: { nodeType: "Index Scan", totalCost: 10, planRows: 10, usesIndexScan: true, raw: {} },
          costRatio: 0.1,
          speedup: 10,
          accepted: true,
          hypopgAvailable: true,
        },
        proofTable: "",
        migration: { dialect: "sql", path: "migrations/x.sql", content: "CREATE INDEX;" },
      },
    ],
    cleanup: { drops: [], totalWriteOverheadBytesPerDay: 0 },
    report: "",
    pr: { created: true, dryRun: false, branch: "b", files: [], message: "m", url: "https://github.local/pr/1" },
    warnings: [],
    ...over,
  }) as ScanResult;

describe("summarize + renderSlackMessage", () => {
  it("counts recommendations and formats top speedup", () => {
    const s = summarize(scan());
    expect(s.provenCount).toBe(1);
    expect(s.topSpeedup).toBe("10.0x");
    const msg = renderSlackMessage(s);
    expect(msg).toContain("demo");
    expect(msg).toContain("*1*");
    expect(msg).toContain("10.0x");
  });

  it("handles empty scans", () => {
    const s = summarize(scan({ recommendations: [], pr: null }));
    expect(s.topSpeedup).toBe("n/a");
    expect(renderSlackMessage(s)).not.toContain("PR:");
  });
});

describe("sendSlackNotification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the rendered message and returns true on 2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ok = await sendSlackNotification("https://hooks.slack.test/t/b/x", scan());
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.test/t/b/x");
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain("pgHeal scan");
  });

  it("returns false on failure without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    expect(await sendSlackNotification("https://hooks.slack.test/x", scan())).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await sendSlackNotification("https://hooks.slack.test/x", scan())).toBe(false);
  });
});
