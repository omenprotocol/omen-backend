-- ============================================================
-- OMEN BACKEND — schema.sql
-- ============================================================
-- Run once at startup via initDB(). All statements are
-- idempotent (IF NOT EXISTS / DO NOTHING).
-- ============================================================

-- ---------------------------------------------------------------------------
-- Core: Creator Profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creator_profiles (
  address          TEXT PRIMARY KEY,
  badge_id         TEXT,
  name             TEXT,
  tier             INTEGER DEFAULT 0,
  is_verified      BOOLEAN DEFAULT FALSE,
  is_active        BOOLEAN DEFAULT TRUE,
  trust_score      INTEGER DEFAULT 0,
  risk_score       INTEGER DEFAULT 0,
  walrus_blob_id   TEXT DEFAULT '',
  issue_date       BIGINT DEFAULT 0,
  revoked_at       BIGINT,
  review_count     INTEGER DEFAULT 0,
  avg_rating       NUMERIC(3,2) DEFAULT 0,
  badge_status     TEXT DEFAULT 'active',   -- 'active' | 'metadata_unavailable' | 'slashed'
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
  applicant    TEXT PRIMARY KEY,
  entity_type  INTEGER,
  name         TEXT,
  paid_amount  BIGINT,
  status       TEXT DEFAULT 'pending',
  applied_at   BIGINT,
  tx_digest    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Reviews (permit-based, on-chain reviewer)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id              SERIAL PRIMARY KEY,
  creator_address TEXT NOT NULL,
  reviewer        TEXT NOT NULL,
  rating          INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  timestamp       BIGINT,
  tx_digest       TEXT UNIQUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Peer Reviews (badge-to-badge, trust-weighted)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS peer_reviews (
  id                SERIAL PRIMARY KEY,
  target_address    TEXT NOT NULL,
  reviewer_address  TEXT NOT NULL,
  reviewer_badge_id TEXT NOT NULL,
  walrus_blob_id    TEXT,
  rating            INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  reviewer_score    INTEGER,
  timestamp         BIGINT,
  is_removed        BOOLEAN DEFAULT FALSE,   -- soft-delete on ReviewRemoved event
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (target_address, reviewer_badge_id)
);

-- ---------------------------------------------------------------------------
-- Gated Trades (DeepBook integration)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gated_trades (
  id              SERIAL PRIMARY KEY,
  trader_address  TEXT NOT NULL,
  router_address  TEXT,
  pool_config_id  TEXT,                      -- OmenPoolConfig object ID
  token_in        TEXT,
  token_out       TEXT,
  amount_in       BIGINT,
  amount_out      BIGINT,
  quantity        BIGINT,                    -- base asset units (alias for amount_in in order context)
  passed_gate     BOOLEAN DEFAULT TRUE,
  trust_score     INTEGER DEFAULT 0,         -- trust score at time of trade
  timestamp       BIGINT,
  tx_digest       TEXT UNIQUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexer State (cursor persistence — Module 2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS indexer_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Audit Ledger — append-only (Module 2: ZKAuditVerified)
-- NEVER UPDATE rows. One row per audit event. Full history preserved.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_ledger (
  id              SERIAL PRIMARY KEY,
  package_id      TEXT NOT NULL,
  creator_address TEXT NOT NULL,
  module_name     TEXT,
  risk_score      INTEGER NOT NULL,
  blob_id         TEXT NOT NULL,
  tx_digest       TEXT UNIQUE,
  audited_at      BIGINT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- API Keys (Module 6: B2B API Key Layer)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id               SERIAL PRIMARY KEY,
  key_hash         TEXT UNIQUE NOT NULL,     -- SHA-256 of raw key — never store raw
  tier             TEXT NOT NULL DEFAULT 'enterprise',
  owner_email      TEXT,
  monthly_limit    INTEGER NOT NULL DEFAULT 10000,
  calls_this_month INTEGER NOT NULL DEFAULT 0,
  reset_at         TIMESTAMPTZ NOT NULL DEFAULT (date_trunc('month', NOW()) + interval '1 month'),
  is_active        BOOLEAN DEFAULT TRUE,
  monthly_usd_cents INTEGER DEFAULT 0,       -- 50000 = $500, 150000 = $1500, 250000 = $2500
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Blob Registry (Module 7: Walrus Blob TTL tracking)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blob_registry (
  id               SERIAL PRIMARY KEY,
  creator_address  TEXT NOT NULL,
  blob_id          TEXT NOT NULL UNIQUE,
  expiry_date      TIMESTAMPTZ NOT NULL,     -- 6-month TTL from upload
  auto_renew       BOOLEAN DEFAULT TRUE,
  status           TEXT DEFAULT 'active',    -- 'active' | 'expiring_soon' | 'expired' | 'metadata_unavailable'
  renewal_attempts INTEGER DEFAULT 0,
  last_verified_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Slash Incidents (Module 8: 30-minute SLA tracking)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS slash_incidents (
  id              SERIAL PRIMARY KEY,
  target_address  TEXT NOT NULL,
  tx_digest       TEXT UNIQUE NOT NULL,
  detected_at     BIGINT NOT NULL,           -- epoch ms when SlashExecuted event received
  resolved_at     BIGINT,                    -- epoch ms when trust_score update confirmed
  resolution_ms   INTEGER,                   -- resolved_at - detected_at
  sla_breached    BOOLEAN DEFAULT FALSE,     -- TRUE if resolution_ms > 1,800,000 (30 min)
  alerted         BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- zkLogin Salts (Module 1: KMS-encrypted salts)
-- encrypted_salt is the KMS ciphertext — raw salt NEVER stored
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zklogin_salts (
  id             SERIAL PRIMARY KEY,
  user_id        TEXT UNIQUE NOT NULL,       -- OIDC sub claim (hashed or opaque ID)
  encrypted_salt TEXT NOT NULL,              -- KMS ciphertext, base64-encoded
  kms_key_id     TEXT,                       -- which KMS key was used (for rotation)
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  rotated_at     TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_reviews_creator          ON reviews (creator_address);
CREATE INDEX IF NOT EXISTS idx_peer_reviews_target      ON peer_reviews (target_address);
CREATE INDEX IF NOT EXISTS idx_peer_reviews_not_removed ON peer_reviews (target_address) WHERE is_removed = FALSE;
CREATE INDEX IF NOT EXISTS idx_gated_trades_trader      ON gated_trades (trader_address);
CREATE INDEX IF NOT EXISTS idx_gated_trades_pool        ON gated_trades (pool_config_id);
CREATE INDEX IF NOT EXISTS idx_creator_trust_score      ON creator_profiles (trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_audit_ledger_creator     ON audit_ledger (creator_address);
CREATE INDEX IF NOT EXISTS idx_audit_ledger_package     ON audit_ledger (package_id);
CREATE INDEX IF NOT EXISTS idx_blob_registry_creator    ON blob_registry (creator_address);
CREATE INDEX IF NOT EXISTS idx_blob_registry_expiry     ON blob_registry (expiry_date);
CREATE INDEX IF NOT EXISTS idx_slash_incidents_address  ON slash_incidents (target_address);
CREATE INDEX IF NOT EXISTS idx_slash_unresolved         ON slash_incidents (detected_at) WHERE resolved_at IS NULL;
