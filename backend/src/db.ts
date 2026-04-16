import postgres from "postgres"

/**
 * Thin wrapper around the `postgres` package so the rest of the codebase can
 * take a `Sql` instance without importing the driver directly. Lets us swap
 * drivers later without cascading changes.
 *
 * Sensible defaults for this workload:
 * - `max: 10` — /ingest is fire-and-forget with short queries; 10 covers us
 *   up through ~100 RPS on a laptop without leaning on pgbouncer.
 * - `idle_timeout: 20` — release idle conns after 20s. Keeps the pool from
 *   stalling behind Postgres max_connections during deploys.
 * - `prepare: false` — `postgres` auto-prepares by default, which breaks
 *   when a connection pooler (pgbouncer transaction mode) is in front. Off
 *   is the safe default; turn on if you know your topology.
 */
export function createSQL(url: string): postgres.Sql {
  return postgres(url, {
    max: 10,
    idle_timeout: 20,
    prepare: false,
  })
}

export type Sql = postgres.Sql
