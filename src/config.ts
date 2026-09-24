import { z } from "zod";

/** pgHeal configuration — validated with zod, DSN never logged. */
export const ConfigSchema = z.object({
  /** PostgreSQL connection string (postgres:// or postgresql://) */
  databaseUrl: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "DATABASE_URL must be a postgres:// or postgresql:// URL"),
  /** GitHub repository, e.g. "acme/api" */
  githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'GITHUB_REPO must look like "owner/name"').optional(),
  /** GitHub token with repo scope (classic) or Contents+PullRequests (fine-grained) */
  githubToken: z.string().min(1).optional(),
  /** base branch for shadow branches and PRs */
  baseBranch: z.string().min(1).default("main"),
  /** migrasyon çıktı dili */
  dialect: z.enum(["sql", "prisma", "django", "rails"]).default("sql"),
  /** migrations directory for sql dialect */
  migrationsDir: z.string().default("migrations"),
  topN: z.number().int().min(1).max(50).default(5),
  minTotalMs: z.number().min(0).default(1000),
  requireProof: z.boolean().default(true),
  unusedIndexDays: z.number().int().min(1).default(30),
  /** connect timeout ms */
  connectTimeoutMs: z.number().int().min(1000).default(10000),
  statementTimeoutMs: z.number().int().min(100).default(15000),
  /** write mode: actually create branch/PR on GitHub */
  write: z.boolean().default(false),
  /** override GitHub API base URL (GHES or local mock server for testing) */
  githubApiUrl: z.string().url().optional(),
  /** optional OpenAI-compatible chat-completions endpoint for PR body enrichment */
  llmApiUrl: z.string().url().optional(),
  /** API key for the LLM endpoint (sent only to llmApiUrl) */
  llmApiKey: z.string().min(1).optional(),
  /** model name for the LLM endpoint (default: gpt-4o-mini) */
  llmModel: z.string().min(1).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const raw = {
    databaseUrl: env.DATABASE_URL,
    githubRepo: env.GITHUB_REPO,
    githubToken: env.GITHUB_TOKEN,
    baseBranch: env.PGHEAL_BASE_BRANCH ?? "main",
    dialect: env.PGHEAL_DIALECT ?? "sql",
    migrationsDir: env.PGHEAL_MIGRATIONS_DIR ?? "migrations",
    topN: num(env.PGHEAL_TOP_N, 5),
    minTotalMs: num(env.PGHEAL_MIN_TOTAL_MS, 1000),
    requireProof: env.PGHEAL_REQUIRE_PROOF !== "false",
    unusedIndexDays: num(env.PGHEAL_UNUSED_DAYS, 30),
    connectTimeoutMs: num(env.PGHEAL_CONNECT_TIMEOUT_MS, 10000),
    statementTimeoutMs: num(env.PGHEAL_STATEMENT_TIMEOUT_MS, 15000),
    write: env.PGHEAL_WRITE === "1" || env.PGHEAL_WRITE === "true",
    githubApiUrl: env.PGHEAL_GITHUB_API_URL || undefined,
    llmApiUrl: env.PGHEAL_LLM_API_URL || undefined,
    llmApiKey: env.PGHEAL_LLM_API_KEY || undefined,
    llmModel: env.PGHEAL_LLM_MODEL || undefined,
    ...overrides,
  };
  return ConfigSchema.parse(raw);
}

function num(v: string | undefined, d: number): number {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** Mask password in DSN for safe logging/display. */
export function maskDsn(dsn: string): string {
  try {
    const u = new URL(dsn);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "postgres://***";
  }
}
