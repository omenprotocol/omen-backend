/**
 * ============================================================
 * OMEN BACKEND — src/indexer/dbUpsert.ts
 * ============================================================
 * Database write operations for the event indexer.
 *
 * Rules enforced here:
 *   • ZKAuditVerified → INSERT into audit_ledger ONLY (never UPDATE)
 *   • SlashExecuted   → UPDATE creator_profiles + record slash_incident
 *   • Cursor          → persisted after every event (no event loss on reboot)
 * ============================================================
 */

import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// Pool — lazy singleton (shares connection with index.ts via env)
// ---------------------------------------------------------------------------

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

export async function initDB(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Walk up to project root to find schema.sql
  const schemaPath = join(__dirname, "../../schema.sql");
  let schema: string;

  try {
    schema = readFileSync(schemaPath, "utf-8");
  } catch {
    throw new Error(
      `[initDB] Cannot read schema.sql at ${schemaPath}. ` +
      `Ensure schema.sql is at the project root.`
    );
  }

  await getPool().query(schema);
  console.log("[DB] initDB: schema applied");
}

// ---------------------------------------------------------------------------
// Creator Profile Operations
// ---------------------------------------------------------------------------

export async function upsertCreatorProfile(data: {
  address:      string;
  badgeId:      string;
  name:         string;
  tier:         number;
  isVerified:   boolean;
  isActive:     boolean;
  trustScore:   number;
  riskScore:    number;
  walrusBlobId: string;
  issueDate:    number;
}): Promise<void> {
  const { address, badgeId, name, tier, isVerified, isActive, trustScore, riskScore, walrusBlobId, issueDate } = data;
  try {
    await getPool().query(
      `INSERT INTO creator_profiles
         (address, badge_id, name, tier, is_verified, is_active, trust_score, risk_score, walrus_blob_id, issue_date, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
       ON CONFLICT (address) DO UPDATE SET
         badge_id       = $2,
         name           = $3,
         tier           = $4,
         is_verified    = $5,
         is_active      = $6,
         trust_score    = $7,
         risk_score     = $8,
         walrus_blob_id = $9,
         issue_date     = $10,
         updated_at     = NOW()`,
      [address, badgeId, name, tier, isVerified, isActive, trustScore, riskScore, walrusBlobId, issueDate]
    );
  } catch (err) {
    console.error("[dbUpsert] upsertCreatorProfile error:", err);
  }
}

export async function updateTrustScore(address: string, score: number): Promise<void> {
  try {
    await getPool().query(
      `UPDATE creator_profiles SET trust_score = $1, updated_at = NOW() WHERE address = $2`,
      [score, address]
    );
  } catch (err) {
    console.error("[dbUpsert] updateTrustScore error:", err);
  }
}

export async function updateRiskScore(address: string, score: number): Promise<void> {
  try {
    await getPool().query(
      `UPDATE creator_profiles SET risk_score = $1, updated_at = NOW() WHERE address = $2`,
      [score, address]
    );
  } catch (err) {
    console.error("[dbUpsert] updateRiskScore error:", err);
  }
}

export async function updateProjectLocked(badgeId: string, locked: boolean): Promise<void> {
  try {
    await getPool().query(
      `UPDATE creator_profiles SET is_active = $1, updated_at = NOW() WHERE badge_id = $2`,
      [!locked, badgeId]
    );
  } catch (err) {
    console.error("[dbUpsert] updateProjectLocked error:", err);
  }
}

export async function updateApplicationStatus(txDigest: string, status: string): Promise<void> {
  try {
    await getPool().query(
      `UPDATE applications SET status = $1 WHERE tx_digest = $2`,
      [status, txDigest]
    );
  } catch (err) {
    console.error("[dbUpsert] updateApplicationStatus error:", err);
  }
}

// ---------------------------------------------------------------------------
// Slash Handling (Module 2 + Module 8)
// ---------------------------------------------------------------------------

export async function handleSlashExecuted(data: {
  address:    string;
  txDigest:   string;
  timestamp:  number;
  newScore?:  number;
}): Promise<void> {
  const { address, txDigest, timestamp, newScore } = data;
  try {
    // 1. Update creator profile — mark slashed
    await getPool().query(
      `UPDATE creator_profiles
       SET trust_score  = $1,
           badge_status = 'slashed',
           is_active    = FALSE,
           updated_at   = NOW()
       WHERE address = $2`,
      [newScore ?? 0, address]
    );

    // 2. Record slash incident for SLA tracking (Module 8)
    await getPool().query(
      `INSERT INTO slash_incidents (target_address, tx_digest, detected_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (tx_digest) DO NOTHING`,
      [address, txDigest, timestamp]
    );

    console.log(`[dbUpsert] SlashExecuted recorded: ${address.slice(0, 10)}... tx=${txDigest.slice(0, 10)}...`);
  } catch (err) {
    console.error("[dbUpsert] handleSlashExecuted error:", err);
  }
}

// ---------------------------------------------------------------------------
// Audit Ledger — APPEND ONLY (Module 2: ZKAuditVerified)
// Never update existing rows. One immutable record per audit event.
// ---------------------------------------------------------------------------

export async function appendAuditLedger(data: {
  creatorAddress: string;
  packageId:      string;
  moduleName:     string;
  riskScore:      number;
  blobId:         string;
  txDigest:       string;
  auditedAt:      number;
}): Promise<void> {
  const { creatorAddress, packageId, moduleName, riskScore, blobId, txDigest, auditedAt } = data;
  try {
    // INSERT only — never UPDATE. ON CONFLICT DO NOTHING protects idempotency.
    await getPool().query(
      `INSERT INTO audit_ledger
         (creator_address, package_id, module_name, risk_score, blob_id, tx_digest, audited_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tx_digest) DO NOTHING`,
      [creatorAddress, packageId, moduleName, riskScore, blobId, txDigest, auditedAt]
    );
    console.log(`[dbUpsert] AuditLedger appended: ${creatorAddress.slice(0, 10)}... score=${riskScore}`);
  } catch (err) {
    console.error("[dbUpsert] appendAuditLedger error:", err);
  }
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export async function insertReview(data: {
  creatorAddress: string;
  reviewer:       string;
  rating:         number;
  timestamp:      number;
  txDigest:       string;
}): Promise<void> {
  const { creatorAddress, reviewer, rating, timestamp, txDigest } = data;
  try {
    await getPool().query(
      `INSERT INTO reviews (creator_address, reviewer, rating, timestamp, tx_digest)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [creatorAddress, reviewer, rating, timestamp, txDigest]
    );
  } catch (err) {
    console.error("[dbUpsert] insertReview error:", err);
  }
}

export async function insertPeerReview(data: {
  targetAddress:   string;
  reviewerAddress: string;
  reviewerBadgeId: string;
  walrusBlobId:    string;
  rating:          number;
  reviewerScore:   number;
  timestamp:       number;
}): Promise<void> {
  const { targetAddress, reviewerAddress, reviewerBadgeId, walrusBlobId, rating, reviewerScore, timestamp } = data;
  try {
    await getPool().query(
      `INSERT INTO peer_reviews
         (target_address, reviewer_address, reviewer_badge_id, walrus_blob_id, rating, reviewer_score, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [targetAddress, reviewerAddress, reviewerBadgeId, walrusBlobId, rating, reviewerScore, timestamp]
    );
  } catch (err) {
    console.error("[dbUpsert] insertPeerReview error:", err);
  }
}

export async function removePeerReview(targetAddress: string, reviewerBadgeId: string): Promise<void> {
  try {
    // Soft delete — set is_removed flag, never hard-delete
    await getPool().query(
      `UPDATE peer_reviews SET is_removed = TRUE
       WHERE target_address = $1 AND reviewer_badge_id = $2`,
      [targetAddress, reviewerBadgeId]
    );
  } catch (err) {
    console.error("[dbUpsert] removePeerReview error:", err);
  }
}

// ---------------------------------------------------------------------------
// Gated Trades
// ---------------------------------------------------------------------------

export async function recordGatedTrade(data: {
  traderAddress: string;
  routerAddress: string;
  poolConfigId:  string | null;
  tokenIn:       string | null;
  tokenOut:      string | null;
  amountIn:      number;
  amountOut:     number;
  quantity:      number;
  passedGate:    boolean;
  trustScore:    number;
  timestamp:     number;
  txDigest:      string;
}): Promise<void> {
  const {
    traderAddress, routerAddress, poolConfigId, tokenIn, tokenOut,
    amountIn, amountOut, quantity, passedGate, trustScore, timestamp, txDigest,
  } = data;
  try {
    await getPool().query(
      `INSERT INTO gated_trades
         (trader_address, router_address, pool_config_id, token_in, token_out,
          amount_in, amount_out, quantity, passed_gate, trust_score, timestamp, tx_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT DO NOTHING`,
      [traderAddress, routerAddress, poolConfigId, tokenIn, tokenOut,
       amountIn, amountOut, quantity, passedGate, trustScore, timestamp, txDigest]
    );
  } catch (err) {
    console.error("[dbUpsert] recordGatedTrade error:", err);
  }
}

// ---------------------------------------------------------------------------
// Cursor Persistence (Module 2 — persist after every event)
// ---------------------------------------------------------------------------

export async function saveLastCursor(cursor: { txDigest: string; eventSeq: string }): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO indexer_state (key, value, updated_at)
       VALUES ('last_cursor', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(cursor)]
    );
  } catch (err) {
    console.error("[dbUpsert] saveLastCursor error:", err);
  }
}

export async function loadLastCursor(): Promise<{ txDigest: string; eventSeq: string } | null> {
  try {
    const result = await getPool().query(
      `SELECT value FROM indexer_state WHERE key = 'last_cursor'`
    );
    if (!result.rows.length) return null;
    return JSON.parse(result.rows[0].value);
  } catch (err) {
    console.error("[dbUpsert] loadLastCursor error:", err);
    return null;
  }
}
