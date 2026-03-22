/**
 * ============================================================
 * OMEN BACKEND — src/api/routes/getProfile.ts
 * ============================================================
 * REST endpoints for creator profile data.
 *
 * Endpoints:
 *   GET /v1/score/:address       — fast trust score (Redis → Postgres)
 *   GET /v1/profile/:address     — full profile with reviews + audit
 *   GET /v1/leaderboard          — top verified creators by score
 *   GET /v1/audit/:blobId        — Walrus audit report proxy
 *   GET /v1/pool/:poolId/stats   — gated pool trading statistics
 *
 * Module 3: Primary read path hits Redis. Falls back to Postgres.
 * Module 7: Responses include badge_status = 'metadata_unavailable'
 *           when the Walrus blob is unresolvable.
 * ============================================================
 */

import express, { type Request, type Response, type Router as RouterType } from "express";
const Router = express.Router;
import { Pool } from "pg";
import { createClient } from "redis";
type RedisClientType = ReturnType<typeof createClient>;
import { fetchAuditReport } from "../../audit/walrus/fetcher.js";

export const profileRouter = Router();

let pg:    Pool;
let redis: RedisClientType;

export function initProfileRouter(pgPool: Pool, redisClient: RedisClientType): void {
  pg    = pgPool;
  redis = redisClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tierLabel(tier: number): string {
  return ["Individual", "Team", "Enterprise"][tier] ?? "Unknown";
}

function riskLabel(score: number): string {
  if (score === 0)  return "Unaudited";
  if (score >= 80)  return "Low Risk";
  if (score >= 50)  return "Medium Risk";
  return "High Risk";
}

function handleError(res: Response, err: unknown, context: string): void {
  console.error(`[API] Error in ${context}:`, err);
  res.status(500).json({ error: true, message: "Internal server error" });
}

// ---------------------------------------------------------------------------
// GET /v1/score/:address
// Module 3: Redis-first, ~20ms target latency
// ---------------------------------------------------------------------------

profileRouter.get("/score/:address", async (req: Request, res: Response) => {
  const { address } = req.params;

  try {
    // Redis first
    const cached = await redis.hGetAll(`omen:profile:${address}`);
    if (cached?.trustScore) {
      return res.json({
        address,
        isVerified:  cached.isVerified === "true",
        isActive:    cached.isActive   === "true",
        trustScore:  Number(cached.trustScore),
        riskScore:   Number(cached.riskScore ?? 0),
        badgeStatus: cached.badgeStatus ?? "active",
        source:      "cache",
      });
    }

    const result = await pg.query(
      `SELECT address, is_verified, is_active, trust_score, risk_score, badge_status
       FROM creator_profiles WHERE address = $1`,
      [address]
    );

    if (!result.rows.length) {
      return res.json({ address, isVerified: false, trustScore: 0, source: "db" });
    }

    const row = result.rows[0];

    // Warm cache — TTL 15 min (Module 3 default)
    await redis.hSet(`omen:profile:${address}`, {
      trustScore:  row.trust_score.toString(),
      riskScore:   row.risk_score.toString(),
      isVerified:  row.is_verified.toString(),
      isActive:    row.is_active.toString(),
      badgeStatus: row.badge_status ?? "active",
    });
    await redis.expire(`omen:profile:${address}`, 900); // 15 min

    return res.json({
      address,
      isVerified:  row.is_verified,
      isActive:    row.is_active,
      trustScore:  row.trust_score,
      riskScore:   row.risk_score,
      badgeStatus: row.badge_status ?? "active",
      source:      "db",
    });

  } catch (err) {
    handleError(res, err, "GET /score/:address");
  }
});

// ---------------------------------------------------------------------------
// GET /v1/profile/:address — full profile
// ---------------------------------------------------------------------------

profileRouter.get("/profile/:address", async (req: Request, res: Response) => {
  const { address } = req.params;

  try {
    const profileResult = await pg.query(
      `SELECT p.*,
              COALESCE(r.recent_reviews, '[]'::json) AS recent_reviews
       FROM creator_profiles p
       LEFT JOIN LATERAL (
         SELECT JSON_AGG(
           JSON_BUILD_OBJECT(
             'reviewer', reviewer,
             'rating',   rating,
             'timestamp', timestamp
           ) ORDER BY timestamp DESC
         ) AS recent_reviews
         FROM (SELECT * FROM reviews WHERE creator_address = p.address LIMIT 5) r
       ) r ON TRUE
       WHERE p.address = $1`,
      [address]
    );

    if (!profileResult.rows.length) {
      return res.status(404).json({
        error:   true,
        message: `No Omen profile found for ${address}`,
      });
    }

    const p = profileResult.rows[0];

    // Trade volume stats — using correct column names from schema
    const tradeResult = await pg.query(
      `SELECT
         COUNT(*)                                               AS total_trades,
         SUM(CASE WHEN passed_gate THEN 1 ELSE 0 END)          AS passed_trades,
         SUM(CASE WHEN NOT passed_gate THEN 1 ELSE 0 END)      AS rejected_trades
       FROM gated_trades
       WHERE trader_address = $1`,
      [address]
    );
    const trades = tradeResult.rows[0];

    // Peer reviews
    const peerReviewResult = await pg.query(
      `SELECT
         reviewer_address,
         reviewer_badge_id,
         walrus_blob_id,
         rating,
         reviewer_score,
         timestamp
       FROM peer_reviews
       WHERE target_address = $1
         AND is_removed = FALSE
       ORDER BY reviewer_score DESC, timestamp DESC
       LIMIT 10`,
      [address]
    );

    const peerStatsResult = await pg.query(
      `SELECT
         COUNT(*)                 AS total_peer_reviews,
         AVG(rating)              AS avg_peer_rating,
         AVG(reviewer_score)      AS avg_reviewer_score
       FROM peer_reviews
       WHERE target_address = $1 AND is_removed = FALSE`,
      [address]
    );
    const peerStats = peerStatsResult.rows[0];

    // Most recent audit from ledger
    const latestAuditResult = await pg.query(
      `SELECT risk_score, blob_id, audited_at
       FROM audit_ledger
       WHERE creator_address = $1
       ORDER BY audited_at DESC
       LIMIT 1`,
      [address]
    );
    const latestAudit = latestAuditResult.rows[0] ?? null;

    // Module 7: Check for metadata_unavailable status
    const metadataUnavailable = p.badge_status === "metadata_unavailable";

    return res.json({
      address:         p.address,
      badgeId:         p.badge_id,
      name:            p.name,
      tier:            p.tier,
      tierLabel:       tierLabel(p.tier),
      trustScore:      p.trust_score,
      riskScore:       p.risk_score,
      riskLabel:       riskLabel(p.risk_score),
      isVerified:      p.is_verified,
      isActive:        p.is_active,
      badgeStatus:     p.badge_status ?? "active",
      walrusBlobId:    p.walrus_blob_id,
      issueDate:       p.issue_date ? new Date(Number(p.issue_date)).toISOString() : null,
      reviewCount:     p.review_count,
      avgRating:       parseFloat(p.avg_rating) || 0,
      recentReviews:   p.recent_reviews,
      gatedTrades: {
        total:    Number(trades.total_trades),
        passed:   Number(trades.passed_trades),
        rejected: Number(trades.rejected_trades),
      },
      peerReviews: {
        total:            Number(peerStats.total_peer_reviews) || 0,
        avgRating:        parseFloat(peerStats.avg_peer_rating) || 0,
        avgReviewerScore: parseFloat(peerStats.avg_reviewer_score) || 0,
        recent: peerReviewResult.rows.map((r) => ({
          reviewerAddress:  r.reviewer_address,
          reviewerBadgeId:  r.reviewer_badge_id,
          walrusBlobId:     r.walrus_blob_id,
          rating:           r.rating,
          reviewerScore:    r.reviewer_score,
          timestamp:        Number(r.timestamp),
          submittedAt:      new Date(Number(r.timestamp)).toISOString(),
        })),
      },
      latestAudit: latestAudit ? {
        riskScore:  latestAudit.risk_score,
        blobId:     latestAudit.blob_id,
        auditedAt:  new Date(Number(latestAudit.audited_at)).toISOString(),
      } : null,
      hasAuditReport:      !!p.walrus_blob_id && !metadataUnavailable,
      metadataUnavailable, // Module 7: clearly flagged — not deleted, just unavailable
      interpretation:
        metadataUnavailable
          ? `${p.name ?? address} — audit metadata temporarily unavailable. Badge is still valid on-chain.`
          : p.is_verified
            ? `${p.name} is a verified ${tierLabel(p.tier)} on Omen Protocol. ` +
              `Trust Score: ${p.trust_score}/100. AI Risk: ${riskLabel(p.risk_score)}.` +
              (Number(peerStats.total_peer_reviews) > 0
                ? ` ${peerStats.total_peer_reviews} peer review(s) from high-trust badge holders.`
                : "")
            : `${address} has no Omen verification. Exercise caution.`,
    });

  } catch (err) {
    handleError(res, err, "GET /profile/:address");
  }
});

// ---------------------------------------------------------------------------
// GET /v1/leaderboard
// ---------------------------------------------------------------------------

profileRouter.get("/leaderboard", async (req: Request, res: Response) => {
  const limit  = Math.min(Number(req.query.limit)  || 20, 100);
  const offset = Number(req.query.offset) || 0;
  const tier   = req.query.tier !== undefined ? Number(req.query.tier) : null;

  try {
    const result = await pg.query(
      `SELECT address, badge_id, name, tier, trust_score, risk_score,
              is_active, review_count, avg_rating, issue_date, badge_status
       FROM creator_profiles
       WHERE is_verified = TRUE
         AND ($3::int IS NULL OR tier = $3)
       ORDER BY trust_score DESC, issue_date ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, tier]
    );

    const countResult = await pg.query(
      `SELECT COUNT(*) FROM creator_profiles
       WHERE is_verified = TRUE AND ($1::int IS NULL OR tier = $1)`,
      [tier]
    );

    return res.json({
      total:    Number(countResult.rows[0].count),
      limit,
      offset,
      creators: result.rows.map((row, i) => ({
        rank:        offset + i + 1,
        address:     row.address,
        badgeId:     row.badge_id,
        name:        row.name,
        tier:        tierLabel(row.tier),
        trustScore:  row.trust_score,
        riskScore:   row.risk_score,
        riskLabel:   riskLabel(row.risk_score),
        isActive:    row.is_active,
        reviewCount: row.review_count,
        avgRating:   parseFloat(row.avg_rating) || 0,
        badgeStatus: row.badge_status ?? "active",
      })),
    });

  } catch (err) {
    handleError(res, err, "GET /leaderboard");
  }
});

// ---------------------------------------------------------------------------
// GET /v1/audit/:blobId — Walrus proxy, Redis-cached 10 min
// ---------------------------------------------------------------------------

profileRouter.get("/audit/:blobId", async (req: Request, res: Response) => {
  const { blobId } = req.params;

  try {
    const cacheKey = `omen:audit:${blobId}`;
    const cached   = await redis.get(cacheKey);
    if (cached) {
      return res.json({ blobId, source: "cache", report: JSON.parse(cached) });
    }

    let report: Awaited<ReturnType<typeof fetchAuditReport>>;
    try {
      report = await fetchAuditReport(blobId);
    } catch {
      // Module 7: blob unresolvable — flag it, don't 500
      return res.status(503).json({
        blobId,
        error:               true,
        metadataUnavailable: true,
        message:             "Audit report blob is currently unresolvable from Walrus storage.",
      });
    }

    await redis.setEx(cacheKey, 600, JSON.stringify(report));

    return res.json({ blobId, source: "walrus", report });

  } catch (err) {
    handleError(res, err, "GET /audit/:blobId");
  }
});

// ---------------------------------------------------------------------------
// GET /v1/pool/:poolId/stats — correct column names from schema
// ---------------------------------------------------------------------------

profileRouter.get("/pool/:poolId/stats", async (req: Request, res: Response) => {
  const { poolId } = req.params;

  try {
    const result = await pg.query(
      `SELECT
         COUNT(*)                                                    AS total_attempts,
         SUM(CASE WHEN passed_gate THEN 1 ELSE 0 END)               AS total_passed,
         SUM(CASE WHEN NOT passed_gate THEN 1 ELSE 0 END)           AS total_rejected,
         AVG(trust_score)                                            AS avg_trust_score,
         SUM(CASE WHEN passed_gate THEN quantity ELSE 0 END)        AS total_volume
       FROM gated_trades
       WHERE pool_config_id = $1`,
      [poolId]
    );

    const row = result.rows[0];
    return res.json({
      poolId,
      totalAttempts: Number(row.total_attempts),
      totalPassed:   Number(row.total_passed),
      totalRejected: Number(row.total_rejected),
      passRate:      row.total_attempts > 0
        ? ((Number(row.total_passed) / Number(row.total_attempts)) * 100).toFixed(1) + "%"
        : "N/A",
      avgTrustScore: parseFloat(row.avg_trust_score) || 0,
      totalVolume:   row.total_volume?.toString() ?? "0",
    });

  } catch (err) {
    handleError(res, err, "GET /pool/:poolId/stats");
  }
});