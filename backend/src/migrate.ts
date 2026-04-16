import { readdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { Sql } from "./db.ts"

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations")

/**
 * File-based migrations. Numbered `.sql` files in `src/migrations/` are
 * applied in lexical order. Each file runs inside a transaction and is
 * recorded in `_migrations` so we never apply the same file twice.
 *
 * This is intentionally the tiniest possible runner:
 * - No down migrations. If you screwed up, write a forward-fix.
 * - No Node binary dependency. It's just a Bun-run function.
 * - No ORM. The whole point of owning Postgres is writing SQL.
 *
 * Production ops flow: deploy → app boots → `runMigrations(sql)` runs →
 * app starts serving. If a migration fails, the app doesn't start. Loud.
 */
export async function runMigrations(sql: Sql): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()

  const applied: string[] = []

  for (const file of files) {
    const existing = await sql<Array<{ name: string }>>`
      SELECT name FROM _migrations WHERE name = ${file}
    `
    if (existing.length > 0) continue

    const content = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    console.log(`[migrate] applying ${file}`)

    // Each migration runs inside a transaction. If any statement fails, the
    // whole file rolls back and `_migrations` is not updated. Next run will
    // retry the same file from scratch.
    await sql.begin(async (tx) => {
      await tx.unsafe(content)
      await tx`INSERT INTO _migrations (name) VALUES (${file})`
    })

    applied.push(file)
  }

  return applied
}
