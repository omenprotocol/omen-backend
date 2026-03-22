/**
 * ============================================================
 * OMEN BACKEND — src/config.ts
 * ============================================================
 * Single source of truth for all on-chain IDs and env config.
 *
 * Testnet deployment (canonical):
 *   Package         : 0x7575a9de7b2b996c314d82ee4e1fe0eb0eec9725c9d96bb324917f8494eae415
 *   Registry        : 0x2dda3a2a639d9747599cffecba9ff9e729c3e16fd886497ac049332ecd4e4d95
 *   AdminCap        : 0x175efee9fa6b6dbc1631324a830d28d5c51d339f14c30df1c0aff785b87ff083
 *   USDC Package    : 0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29
 *   Deployer        : 0x4315fca49167973c154a038ba9b8f6afd5bf9d50ab7e46e8dbac04d3427dbe7f
 *
 * Mainnet: swap env values only — no code changes.
 * USDC → USDsui at mainnet: single coin type substitution.
 * ============================================================
 */

export const NETWORK = (
  process.env.SUI_NETWORK ?? "testnet"
) as "mainnet" | "testnet" | "devnet";

// ---------------------------------------------------------------------------
// On-chain IDs
// ---------------------------------------------------------------------------

export const PACKAGE_ID: string =
  process.env.PACKAGE_ID ??
  "0x7575a9de7b2b996c314d82ee4e1fe0eb0eec9725c9d96bb324917f8494eae415";

export const OMEN_REGISTRY_ID: string =
  process.env.OMEN_REGISTRY_ID ??
  process.env.REGISTRY_ID ??
  "0x2dda3a2a639d9747599cffecba9ff9e729c3e16fd886497ac049332ecd4e4d95";

// Never expose in API responses or logs
export const ADMIN_CAP_ID: string =
  process.env.ADMIN_CAP_ID ??
  "0x175efee9fa6b6dbc1631324a830d28d5c51d339f14c30df1c0aff785b87ff083";

export const DEPLOYER_ADDRESS: string =
  process.env.DEPLOYER_ADDRESS ??
  "0x4315fca49167973c154a038ba9b8f6afd5bf9d50ab7e46e8dbac04d3427dbe7f";

// ---------------------------------------------------------------------------
// USDC — testnet coin type
// Mainnet: swap USDC_PACKAGE env var to USDsui package — logic unchanged
// ---------------------------------------------------------------------------

export const USDC_PACKAGE: string =
  process.env.USDC_PACKAGE ??
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29";

export const USDC_COIN_TYPE = `${USDC_PACKAGE}::usdc::USDC`;

export const CLOCK_ID = "0x6";

// ---------------------------------------------------------------------------
// Move event types
// ---------------------------------------------------------------------------

export const EVENTS = {
  // omen_registry
  ApplicationSubmitted:  `${PACKAGE_ID}::omen_registry::ApplicationSubmitted`,
  ApplicationApproved:   `${PACKAGE_ID}::omen_registry::ApplicationApproved`,
  ApplicationRejected:   `${PACKAGE_ID}::omen_registry::ApplicationRejected`,
  CreatorVerified:       `${PACKAGE_ID}::omen_registry::CreatorVerified`,
  CreatorRevoked:        `${PACKAGE_ID}::omen_registry::CreatorRevoked`,
  TrustScoreUpdated:     `${PACKAGE_ID}::omen_registry::TrustScoreUpdated`,
  StatusChanged:         `${PACKAGE_ID}::omen_registry::StatusChanged`,
  SlashExecuted:         `${PACKAGE_ID}::omen_registry::SlashExecuted`,
  ZKAuditVerified:       `${PACKAGE_ID}::omen_registry::ZKAuditVerified`,
  AuditRequested:        `${PACKAGE_ID}::omen_registry::AuditRequested`,
  AuditCompleted:        `${PACKAGE_ID}::omen_registry::AuditCompleted`,
  // omen_badge
  ReviewPosted:          `${PACKAGE_ID}::omen_badge::ReviewPosted`,
  ProjectLocked:         `${PACKAGE_ID}::omen_badge::ProjectLocked`,
  RiskScoreIssued:       `${PACKAGE_ID}::omen_badge::RiskScoreIssued`,
  // reviews
  ReviewSubmitted:       `${PACKAGE_ID}::reviews::ReviewSubmitted`,
  ReviewRemoved:         `${PACKAGE_ID}::reviews::ReviewRemoved`,
  // omen_router (corrected from "router")
  TrustGatePassed:       `${PACKAGE_ID}::omen_router::TrustGatePassed`,
  TrustGateRejected:     `${PACKAGE_ID}::omen_router::TrustGateRejected`,
  AutoPauseEvent:        `${PACKAGE_ID}::omen_router::AutoPauseEvent`,
  GatedPoolCreated:      `${PACKAGE_ID}::omen_router::GatedPoolCreated`,
  PoolSuspended:         `${PACKAGE_ID}::omen_router::PoolSuspended`,
  CircuitReset:          `${PACKAGE_ID}::omen_router::CircuitReset`,
} as const;

// Must match actual module names in the deployed package
export const POLL_MODULES = [
  "omen_registry",
  "omen_badge",
  "reviews",
  "omen_router",  // corrected from "router"
] as const;

// ---------------------------------------------------------------------------
// Struct types
// ---------------------------------------------------------------------------

export const STRUCT_TYPES = {
  OmenBadge:    `${PACKAGE_ID}::omen_badge::OmenBadge`,
  AdminCap:     `${PACKAGE_ID}::omen_registry::AdminCap`,
  AuditorBadge: `${PACKAGE_ID}::omen_badge::AuditorBadge`,
} as const;

export const DF_KEYS = {
  TrustScore:       `${PACKAGE_ID}::omen_badge::TrustScoreKey`,
  IsActive:         `${PACKAGE_ID}::omen_badge::StatusKey`,
  VerificationTier: `${PACKAGE_ID}::omen_badge::VerificationTierKey`,
  ReviewCount:      `${PACKAGE_ID}::omen_badge::ReviewCountKey`,
  RiskScore:        `${PACKAGE_ID}::omen_badge::RiskScoreKey`,
  WalrusBlobId:     `${PACKAGE_ID}::omen_badge::WalrusBlobIdKey`,
  PremiumExpiry:    `${PACKAGE_ID}::omen_badge::PremiumExpiryKey`,
  AuditExpiry:      `${PACKAGE_ID}::omen_badge::AuditExpiryKey`,
} as const;

// ---------------------------------------------------------------------------
// SDK fallback (Module 4)
// ---------------------------------------------------------------------------

export const API_BASE_URL   = process.env.OMEN_API_BASE_URL ?? "https://api.omenlabs.com";
export const SDK_TIMEOUT_MS = 2_000; // hard limit before RPC fallback

// ---------------------------------------------------------------------------
// Server / DB / Cache
// ---------------------------------------------------------------------------

export const PORT         = Number(process.env.PORT ?? 3000);
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost:5432/omen";
export const REDIS_URL    = process.env.REDIS_URL    ?? "redis://localhost:6379";

// ---------------------------------------------------------------------------
// Walrus
// ---------------------------------------------------------------------------

export const WALRUS_AGGREGATOR_URL =
  process.env.WALRUS_AGGREGATOR_URL ?? "https://aggregator-devnet.walrus.space";

export const WALRUS_PUBLISHER_URL =
  process.env.WALRUS_PUBLISHER_URL ?? "https://publisher-devnet.walrus.space";

// ---------------------------------------------------------------------------
// ZK / KMS / Turnstile / Alerts
// ---------------------------------------------------------------------------

export const ZK_PROVER_URL         = process.env.ZK_PROVER_URL ?? "https://prover-dev.mystenlabs.com/v1";
export const KMS_KEY_ID            = process.env.KMS_KEY_ID;
export const AWS_REGION            = process.env.AWS_REGION ?? "us-east-1";
export const TURNSTILE_SECRET_KEY  = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
export const SLACK_WEBHOOK_URL     = process.env.SLACK_WEBHOOK_URL;
export const PAGERDUTY_ROUTING_KEY = process.env.PAGERDUTY_ROUTING_KEY;

// ---------------------------------------------------------------------------
// Boot validation
// ---------------------------------------------------------------------------

export function validateConfig(): void {
  const warnings: string[] = [];

  // Read process.env directly here — dotenv has run by the time this is called
  if (!process.env.DATABASE_URL)
    warnings.push("DATABASE_URL not set — using localhost default");
  if (!process.env.REDIS_URL)
    warnings.push("REDIS_URL not set — using localhost default");
  if (!process.env.KMS_KEY_ID)
    warnings.push("KMS_KEY_ID not set — salt encryption unavailable until configured");
  if (!process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY)
    warnings.push("CLOUDFLARE_TURNSTILE_SECRET_KEY not set — mint gate will reject all requests");
  if (!process.env.SLACK_WEBHOOK_URL && !process.env.PAGERDUTY_ROUTING_KEY)
    warnings.push("No alert channel configured — SLA breaches will only log to console");

  for (const w of warnings) console.warn(`[Config] ⚠️  ${w}`);

  console.log(
    `[Config] ✅ Network: ${NETWORK} | ` +
    `Package: ${PACKAGE_ID.slice(0, 10)}... | ` +
    `Registry: ${OMEN_REGISTRY_ID.slice(0, 10)}...`
  );
}

// ---------------------------------------------------------------------------
// Runtime accessors — call these AFTER dotenv has loaded, not at module level
// These always reflect the current process.env state
// ---------------------------------------------------------------------------

export function getKmsKeyId():           string | undefined { return process.env.KMS_KEY_ID; }
export function getTurnstileKey():        string | undefined { return process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY; }
export function getSlackWebhookUrl():     string | undefined { return process.env.SLACK_WEBHOOK_URL; }
export function getPagerdutyRoutingKey(): string | undefined { return process.env.PAGERDUTY_ROUTING_KEY; }