/**
 * ============================================================
 * OMEN BACKEND — src/middleware/apiKeyMiddleware.ts
 * ============================================================
 * Module 6: B2B API Key Layer
 *
 * Free tier:
 *   • Up to 10,000 GET /badge/:address calls per month
 *   • No API key required
 *   • Rate-limited by IP via Redis
 *
 * Enterprise tiers (API key required):
 *   • $500 USDC/mo   — Standard
 *   • $1,500 USDC/mo — Growth
 *   • $2,500+ USDC/mo — Institutional
 *   Testnet: denominated in USDC (Sui testnet contract)
 *   Mainnet: swap USDC → USDsui (single type substitution at deploy)
 *
 * Rate limiting enforced in Redis.
 * API keys stored as SHA-256 hash — raw key never persisted.
 * ============================================================
 */

import type { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { Pool } from "pg";
import { createClient } from "redis";
type RedisClientType = ReturnType<typeof createClient>;
import rateLimit from "express-rate-limit";
import RedisStore from "rate-limit-redis";

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------
// Currency: USDC on Sui testnet. USDsui replaces at mainnet — logic unchanged.

export interface ApiKeyTier {
  name:           string;
  monthlyLimit:   number;     // max API calls per month
  ratePerMinute:  number;     // burst rate limit
  monthlyUsdCents: number;    // USDC equivalent (testnet) / USDsui (mainnet)
}

export const TIERS: Record<string, ApiKeyTier> = {
  free: {
    name:            "Free",
    monthlyLimit:    10_000,
    ratePerMinute:   60,
    monthlyUsdCents: 0,
  },
  standard: {
    name:            "Standard",
    monthlyLimit:    500_000,
    ratePerMinute:   300,
    monthlyUsdCents: 50_000,   // $500 USDC
  },
  growth: {
    name:            "Growth",
    monthlyLimit:    5_000_000,
    ratePerMinute:   1_000,
    monthlyUsdCents: 150_000,  // $1,500 USDC
  },
  institutional: {
    name:            "Institutional",
    monthlyLimit:    -1,       // unlimited
    ratePerMinute:   10_000,
    monthlyUsdCents: 250_000,  // $2,500+ USDC (negotiated)
  },
};

const FREE_TIER_IP_LIMIT       = 10_000;      // per month per IP
const FREE_TIER_IP_KEY_PREFIX  = "omen:free:ip:";
const API_KEY_HEADER           = "x-api-key";
const MONTH_SECONDS            = 30 * 24 * 3600;

// ---------------------------------------------------------------------------
// Shared clients — injected at startup
// ---------------------------------------------------------------------------

let pg:    Pool;
let redis: RedisClientType;

export function initApiKeyMiddleware(pgPool: Pool, redisClient: RedisClientType): void {
  pg    = pgPool;
  redis = redisClient;
}

// ---------------------------------------------------------------------------
// Hash API key — raw key never stored in DB or Redis
// ---------------------------------------------------------------------------

function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

// ---------------------------------------------------------------------------
// Free tier rate limiter (Module 6: no key required, 10k/month per IP)
// ---------------------------------------------------------------------------

export const freeRateLimiter = rateLimit({
  windowMs:        30 * 24 * 60 * 60 * 1000, // 30 days
  max:             FREE_TIER_IP_LIMIT,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) =>
    (req.headers["cf-connecting-ip"] as string) ??
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.ip ??
    "unknown",
  skip: (req) => !!req.headers[API_KEY_HEADER], // skip if enterprise key present
  handler: (_req, res) => {
    res.status(429).json({
      error:   true,
      code:    "FREE_TIER_LIMIT_EXCEEDED",
      message:
        "Free tier limit of 10,000 calls/month reached. " +
        "Upgrade to an enterprise API key at omenlabs.com/api",
    });
  },
});

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

interface KeyRecord {
  id:              number;
  tier:            string;
  monthly_limit:   number;
  calls_this_month: number;
  reset_at:        Date;
  is_active:       boolean;
}

async function validateApiKey(rawKey: string): Promise<KeyRecord | null> {
  const keyHash = hashApiKey(rawKey);

  // Check Redis cache first (5-minute TTL for key metadata)
  const cacheKey    = `omen:apikey:${keyHash}`;
  const cachedValue = await redis.get(cacheKey);

  if (cachedValue) {
    return JSON.parse(cachedValue) as KeyRecord;
  }

  // Fallback to Postgres
  const result = await pg.query(
    `SELECT id, tier, monthly_limit, calls_this_month, reset_at, is_active
     FROM api_keys WHERE key_hash = $1`,
    [keyHash]
  );

  if (!result.rows.length) return null;

  const record = result.rows[0] as KeyRecord;

  // Cache for 5 minutes
  await redis.setEx(cacheKey, 300, JSON.stringify(record));

  return record;
}

async function incrementCallCount(keyHash: string, keyId: number): Promise<void> {
  // Increment in Redis atomically (fast path)
  const counterKey = `omen:apikey:calls:${keyHash}:${new Date().toISOString().slice(0, 7)}`; // YYYY-MM
  await redis.incr(counterKey);
  await redis.expire(counterKey, MONTH_SECONDS);

  // Async DB update — non-blocking, best-effort
  pg.query(
    `UPDATE api_keys
     SET calls_this_month = calls_this_month + 1, updated_at = NOW()
     WHERE id = $1`,
    [keyId]
  ).catch((err) => console.error("[ApiKey] DB increment error:", err));
}

// ---------------------------------------------------------------------------
// apiKeyMiddleware — enterprise key enforcement
// ---------------------------------------------------------------------------

/**
 * For routes that accept an enterprise API key.
 * If no key is present, the request passes through (handled by freeRateLimiter).
 * If a key IS present, it must be valid, active, and within monthly limits.
 */
export async function apiKeyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const rawKey = req.headers[API_KEY_HEADER] as string | undefined;

  // No key — let freeRateLimiter handle it
  if (!rawKey) {
    next();
    return;
  }

  try {
    const record = await validateApiKey(rawKey);

    if (!record) {
      res.status(401).json({
        error:   true,
        code:    "INVALID_API_KEY",
        message: "The provided API key is not recognized.",
      });
      return;
    }

    if (!record.is_active) {
      res.status(403).json({
        error:   true,
        code:    "API_KEY_INACTIVE",
        message: "This API key has been deactivated. Contact support@omenlabs.com.",
      });
      return;
    }

    // Reset monthly counter if past reset date
    const now = new Date();
    if (now > new Date(record.reset_at)) {
      await pg.query(
        `UPDATE api_keys
         SET calls_this_month = 0, reset_at = date_trunc('month', NOW()) + interval '1 month'
         WHERE id = $1`,
        [record.id]
      );
      record.calls_this_month = 0;
    }

    // Check monthly limit (institutional tier is unlimited: -1)
    const tier = TIERS[record.tier] ?? TIERS.standard!;
    if (tier.monthlyLimit !== -1 && record.calls_this_month >= record.monthly_limit) {
      res.status(429).json({
        error:       true,
        code:        "MONTHLY_LIMIT_EXCEEDED",
        message:     `Monthly limit of ${record.monthly_limit.toLocaleString()} calls reached.`,
        resetsAt:    record.reset_at,
        upgradePath: "Contact enterprise@omenlabs.com to increase your quota.",
      });
      return;
    }

    // Attach key info to request for downstream use
    (req as any).apiKey = {
      id:           record.id,
      tier:         record.tier,
      tierConfig:   tier,
      callsUsed:    record.calls_this_month,
      callsLimit:   record.monthly_limit,
    };

    // Increment counter asynchronously
    const keyHash = hashApiKey(rawKey);
    incrementCallCount(keyHash, record.id).catch(() => {});

    // Attach rate limit headers
    res.setHeader("X-Omen-Tier",       tier.name);
    res.setHeader("X-Omen-Calls-Used", record.calls_this_month.toString());
    if (tier.monthlyLimit !== -1) {
      res.setHeader("X-Omen-Calls-Limit", record.monthly_limit.toString());
    }

    next();

  } catch (err) {
    console.error("[ApiKey] Middleware error:", err);
    res.status(500).json({
      error:   true,
      code:    "API_KEY_VALIDATION_ERROR",
      message: "Could not validate API key. Please retry.",
    });
  }
}

// ---------------------------------------------------------------------------
// Admin: provision a new API key (called by internal admin routes)
// ---------------------------------------------------------------------------

export interface NewKeyResult {
  rawKey:    string;   // shown ONCE to the customer — never stored
  keyPrefix: string;   // first 8 chars for identification
  tier:      string;
}

export async function provisionApiKey(
  ownerEmail:       string,
  tier:             keyof typeof TIERS,
  monthlyUsdCents?: number
): Promise<NewKeyResult> {
  const { randomBytes } = await import("crypto");
  const rawKey    = "omen_" + randomBytes(32).toString("hex");
  const keyHash   = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 13);

  const tierConfig = TIERS[tier] ?? TIERS.standard!;
  const usdCents   = monthlyUsdCents ?? tierConfig.monthlyUsdCents;

  await pg.query(
    `INSERT INTO api_keys
       (key_hash, tier, owner_email, monthly_limit, monthly_usd_cents, reset_at)
     VALUES ($1, $2, $3, $4, $5, date_trunc('month', NOW()) + interval '1 month')`,
    [keyHash, tier, ownerEmail, tierConfig.monthlyLimit, usdCents]
  );

  console.log(`[ApiKey] Provisioned ${tier} key for ${ownerEmail} (prefix: ${keyPrefix})`);

  return { rawKey, keyPrefix, tier };
}