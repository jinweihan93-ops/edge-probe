-- Slice 4 — Ingest hardening.
--
-- Two additions:
--   1. `ingest_dedup` — the UNIQUE(org_id, content_hash, minute_bucket)
--      table that backs replay suppression. The app INSERTs; ON CONFLICT
--      tells us it was a duplicate. We silently 202 it at the endpoint.
--   2. Retention — nothing schema-side; the app runs `DELETE FROM traces
--      WHERE started_at < now() - 30d` on a scheduled timer. Spans CASCADE.
--      We add an index on traces(started_at) so the delete scans only the
--      tail. The per-org leading index from 001_init is great for reads
--      but doesn't help a cross-org time sweep.

CREATE TABLE IF NOT EXISTS ingest_dedup (
  org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  content_hash   TEXT NOT NULL,                -- SHA-256 hex of request body
  minute_bucket  TIMESTAMPTZ NOT NULL,          -- UTC minute-floored
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, content_hash, minute_bucket)
);

-- Fast pruning of old dedup rows. The /purge sweep removes stale entries
-- so the table doesn't grow unbounded.
CREATE INDEX IF NOT EXISTS ingest_dedup_created_idx
  ON ingest_dedup(created_at);

-- Retention-friendly index on traces. The 001 schema has
-- (org_id, started_at DESC) which is right for per-org lists, but the
-- retention sweep goes org-agnostic. A second index on started_at alone
-- lets the DELETE use an index range scan rather than a seq scan at scale.
CREATE INDEX IF NOT EXISTS traces_started_idx
  ON traces(started_at);
