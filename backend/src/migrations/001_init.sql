-- EdgeProbe Postgres schema — Day 1 PII boundary is enforced here, not in app code.
--
-- The INVARIANT we never break: a developer writing a dashboard endpoint cannot
-- accidentally query prompt/completion text and render it on a public URL.
-- We achieve that by having TWO physically separate views. The public view
-- literally does not select the content columns. No `CASE WHEN public THEN ...`.
-- No `WHERE visibility = 'public'`. Two queries, two views, one truth.
--
-- Critical Path #1 (public share URL never renders prompt/completion text) and
-- Critical Path #3 (per-call opt-in does not escalate to public visibility)
-- are enforced by this schema + the view-selection rule in src/views.ts.

-- ==================== Organizations ====================

CREATE TABLE IF NOT EXISTS orgs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- ==================== API keys (two-key model) ====================

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,         -- short id for logs/revocation
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL,             -- bcrypt/argon2 hash of the raw token
  key_prefix    TEXT NOT NULL,             -- 'epk_pub_' | 'epk_priv_'
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_org_prefix_idx ON api_keys(org_id, key_prefix);

-- ==================== Traces + spans ====================
-- Raw storage. Everything the SDK sends lands here, intact.
-- The views below are how we read it safely.

CREATE TABLE IF NOT EXISTS traces (
  id             TEXT PRIMARY KEY,           -- trace_id from OTel
  org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL,
  session_id     TEXT,                        -- gen_ai session attr; nullable for single-turn
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  device         JSONB NOT NULL,              -- {model, os, build, commit, ...}
  attributes     JSONB NOT NULL DEFAULT '{}',
  sensitive      BOOLEAN NOT NULL DEFAULT false  -- operator-set kill switch for public sharing
);

CREATE INDEX IF NOT EXISTS traces_org_started_idx ON traces(org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS traces_session_idx ON traces(session_id) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS spans (
  id                 TEXT PRIMARY KEY,           -- span_id from OTel
  trace_id           TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  parent_span_id     TEXT,
  name               TEXT NOT NULL,               -- e.g. 'whisper-decode', 'llama-prefill'
  kind               TEXT NOT NULL,               -- 'llm' | 'asr' | 'tts' | custom
  started_at         TIMESTAMPTZ NOT NULL,
  ended_at           TIMESTAMPTZ NOT NULL,
  duration_ms        INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'ok',  -- 'ok' | 'error'
  attributes         JSONB NOT NULL DEFAULT '{}', -- gen_ai.* attrs, device state, etc.

  -- Opt-in content. If `include_content` is false, these columns stay NULL.
  -- Even when populated, they are ONLY readable via v_private_spans, never v_public_spans.
  include_content    BOOLEAN NOT NULL DEFAULT false,
  prompt_text        TEXT,
  completion_text    TEXT,
  transcript_text    TEXT
);

CREATE INDEX IF NOT EXISTS spans_trace_idx ON spans(trace_id, started_at);

-- ==================== Share tokens (public URLs) ====================

CREATE TABLE IF NOT EXISTS share_tokens (
  token          TEXT PRIMARY KEY,            -- random 8-12 char URL-safe id
  trace_id       TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS share_tokens_trace_idx ON share_tokens(trace_id);

-- ==================== PII BOUNDARY VIEWS — the whole game ====================
--
-- Anything that renders /r/{token} MUST query v_public_spans. Full stop.
-- Anything that renders /app/trace/{id} (authenticated) queries v_private_spans.
-- The two queries are physically different. A bug in one does not affect the other.
-- If someone tries to JOIN private content to a public endpoint, it will not compile.

-- Public view: NO prompt_text, completion_text, transcript_text, include_content.
-- Only timings, span tree, names, status, and non-sensitive attributes.
CREATE OR REPLACE VIEW v_public_spans AS
SELECT
  s.id,
  s.trace_id,
  s.parent_span_id,
  s.name,
  s.kind,
  s.started_at,
  s.ended_at,
  s.duration_ms,
  s.status,
  -- strip any attribute key that starts with 'content.' or is in a denylist
  (s.attributes
    - 'content.prompt'
    - 'content.completion'
    - 'content.transcript'
    - 'gen_ai.prompt'
    - 'gen_ai.completion'
    - 'user.input'
    - 'user.output'
  ) AS attributes
FROM spans s
JOIN traces t ON t.id = s.trace_id
WHERE t.sensitive = false;

-- Private view: everything, visible only to authenticated org members.
CREATE OR REPLACE VIEW v_private_spans AS
SELECT
  s.id,
  s.trace_id,
  s.parent_span_id,
  s.name,
  s.kind,
  s.started_at,
  s.ended_at,
  s.duration_ms,
  s.status,
  s.attributes,
  s.include_content,
  s.prompt_text,
  s.completion_text,
  s.transcript_text
FROM spans s;
