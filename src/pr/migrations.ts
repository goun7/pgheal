import type { IndexCandidate, MigrationFile } from "../types.js";
import { indexDdl, indexName, prismaInstructions } from "../analysis/ddl.js";

/** Migration generators per dialect (paper §6). */

const STAMP = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

export function sqlMigration(c: IndexCandidate): MigrationFile {
  const name = indexName(c);
  return {
    dialect: "sql",
    path: `migrations/${STAMP}_${name}.sql`,
    content: `-- pgHeal: proven index recommendation\n-- Table: ${c.table} · Columns: ${c.columns.join(", ")}\n-- Reason: ${c.reason}\n-- NOTE: CONCURRENTLY avoids blocking writes; run outside a transaction.\n\n${indexDdl(c, { concurrently: true })}\n`,
  };
}

export function prismaMigration(c: IndexCandidate): MigrationFile {
  const base = sqlMigration(c);
  const name = indexName(c);
  return {
    dialect: "prisma",
    path: `prisma/migrations/${STAMP}_${name}/migration.sql`,
    content: `${base.content}\n-- ${prismaInstructions().join("\n-- ")}\n`,
  };
}

export function djangoMigration(c: IndexCandidate): MigrationFile {
  const name = indexName(c);
  const content = `from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations
from django.db.models import Index

class Migration(migrations.Migration):
    # AddIndexConcurrently requires non-atomic migrations (Django docs)
    atomic = False

    dependencies = [
        ("app", "0001_initial"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="${c.table.toLowerCase()}",
            index=Index(
                fields=[${c.columns.map((col) => `"${col}"`).join(", ")}],
                name="${name.slice(0, 30)}",
            ),
        ),
    ]
`;
  return { dialect: "django", path: `app/migrations/${STAMP}_${name}.py`, content };
}

export function railsMigration(c: IndexCandidate): MigrationFile {
  const name = indexName(c);
  const content = `# pgHeal: proven index recommendation
# frozen_string_literal: true

class ${className(name)} < ActiveRecord::Migration[7.1]
  disable_ddl_transaction!

  def change
    add_index :${snakeCase(c.table)}, ${arrayLiteral(c.columns)}, algorithm: :concurrently
  end
end
`;
  return { dialect: "rails", path: `db/migrate/${STAMP}${name.split("_").map(capitalize).join("")}.rb`, content };
}

export function buildMigration(c: IndexCandidate, dialect: string): MigrationFile {
  switch (dialect) {
    case "prisma":
      return prismaMigration(c);
    case "django":
      return djangoMigration(c);
    case "rails":
      return railsMigration(c);
    case "sql":
    default:
      return sqlMigration(c);
  }
}

function className(s: string): string {
  return s
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function snakeCase(s: string): string {
  return s.toLowerCase();
}function arrayLiteral(items: string[]): string {
  return `[${items.map((i) => `"${i}"`).join(", ")}]`;
}
