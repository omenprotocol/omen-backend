/**
 * ============================================================
 * OMEN BACKEND — src/config.ts
 * ============================================================
 * Single source of truth for all on-chain IDs and env config.
 *
 * Current deployment (testnet):
 *   Package       : 0x45106c780b5d227417c77ec372f8a17ee82f1a3c76553a6e07b3f7bdd322ebd8
 *   OmenRegistry  : 0x526fa02ef5965ba3a5422ccde7a7209af74710e058c141ab07716b493fdb7669
 *   TypeRegistry  : 0xfebb579d03dc73285f8b8fbb1cb9d4401dd3cceb92445a1e030a9f2e37f4d4b0
 *   AdminCap      : 0xd8bfcac7c355b7e9024e104944b2f183a3bbc7731dc0b2cd676eec48ad18f469
 *   UpgradeCap    : 0xee64bcaf14a9ade5a00ad215fda28fe77c486680b9ecfb5c80cc2681f0213ba4
 *   Deployer      : 0x4315fca49167973c154a038ba9b8f6afd5bf9d50ab7e46e8dbac04d3427dbe7f
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
  "0x45106c780b5d227417c77ec372f8a17ee82f1a3c76553a6e07b3f7bdd322ebd8";

export const OMEN_REGISTRY_ID: string =
  process.env.OMEN_REGISTRY_ID ??
  process.env.REGISTRY_ID ??
  "0x526fa02ef5965ba3a5422ccde7a7209af74710e058c141ab07716b493fdb7669";

export const TYPE_REGISTRY_ID: string =
  process.env.TYPE_REGISTRY_ID ??
  "0xfebb579d03dc73285f8b8fbb1cb9d4401dd3cceb92445a1e030a9f2e37f4d4b0";

// Never expose in API responses or logs
export const ADMIN_CAP_ID: string =
  process.env.ADMIN_CAP_ID ??
  "0xd8bfcac7c355b7e9024e104944b2f183a3bbc7731dc0b2cd676eec48ad18f469";

export const UPGRADE_CAP_ID: string =
  process.env.UPGRADE_CAP_ID ??
  "0xee64bcaf14a9ade5a00ad215fda28fe77c486680b9ecfb5c80cc2681f0213ba4";

export const DEPLOYER_ADDRESS: string =
  process.env.DEPLOYER_ADDRESS ??
  "0x4315fca49167973c154a038ba9b8f6afd5bf9d50ab7e46e8dbac04d3427dbe7f";

// ---------------------------------------------------------------------------
// USDC — testnet coin type
// Mainnet: swap USDC_PACKAGE to USDsui package — logic unchanged
// ---------------------------------------------------------------------------

export const USDC_PACKAGE: string =
  process.env.USDC_PACKAGE ??
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29";

export const USDC_COIN_TYPE = `${USDC_PACKAGE}::usdc::USDC`;

export const CLOCK_ID = "0x6";

// ---------------------------------------------------------------------------
// Move event types — all modules confirmed from on-chain package
// Modules: omen_registry, omen_badge, omen_agent, router, vault, reviews, omen_type_registry
// ---------------------------------------------------------------------------

export const EVENTS = {
  // omen_registry
  ApplicationSubmitted:     `${PACKAGE_ID}::omen_registry::ApplicationSubmitted`,
  ApplicationApproved:      `${PACKAGE_ID}::omen_registry::ApplicationApproved`,
  ApplicationRejected:      `${PACKAGE_ID}::omen_registry::ApplicationRejected`,
  CreatorVerified:          `${PACKAGE_ID}::omen_registry::CreatorVerified`,
  CreatorRevoked:           `${PACKAGE_ID}::omen_registry::CreatorRevoked`,
  StatusChanged:            `${PACKAGE_ID}::omen_registry::StatusChanged`,
  SlashExecuted:            `${PACKAGE_ID}::omen_registry::SlashExecuted`,
  AuditRequested:           `${PACKAGE_ID}::omen_registry::AuditRequested`,
  AuditCompleted:           `${PACKAGE_ID}::omen_registry::AuditCompleted`,
  StakeDeposited:           `${PACKAGE_ID}::omen_registry::StakeDeposited`,
  StakeSlashed:             `${PACKAGE_ID}::omen_registry::StakeSlashed`,
  StakeReturned:            `${PACKAGE_ID}::omen_registry::StakeReturned`,
  BondDeposited:            `${PACKAGE_ID}::omen_registry::BondDeposited`,
  BondSeized:               `${PACKAGE_ID}::omen_registry::BondSeized`,
  BondReleased:             `${PACKAGE_ID}::omen_registry::BondReleased`,
  AuditorProposalCreated:   `${PACKAGE_ID}::omen_registry::AuditorProposalCreated`,
  AuditorProposalApproved:  `${PACKAGE_ID}::omen_registry::AuditorProposalApproved`,
  AuditorBadgeExecuted:     `${PACKAGE_ID}::omen_registry::AuditorBadgeExecuted`,
  AgentBadgeIssued:         `${PACKAGE_ID}::omen_registry::AgentBadgeIssued`,
  // omen_badge — TrustScoreUpdated moved here from omen_registry
  TrustScoreUpdated:        `${PACKAGE_ID}::omen_badge::TrustScoreUpdated`,
  ZKAuditVerified:          `${PACKAGE_ID}::omen_badge::ZKAuditVerified`,
  ReviewPosted:             `${PACKAGE_ID}::omen_badge::ReviewPosted`,
  ProjectLocked:            `${PACKAGE_ID}::omen_badge::ProjectLocked`,
  RiskScoreIssued:          `${PACKAGE_ID}::omen_badge::RiskScoreIssued`,
  RecoveryProposed:         `${PACKAGE_ID}::omen_badge::RecoveryProposed`,
  RecoveryApproved:         `${PACKAGE_ID}::omen_badge::RecoveryApproved`,
  RecoveryExecuted:         `${PACKAGE_ID}::omen_badge::RecoveryExecuted`,
  RecoveryCancelled:        `${PACKAGE_ID}::omen_badge::RecoveryCancelled`,
  AuditRecorded:            `${PACKAGE_ID}::omen_badge::AuditRecorded`,
  AuditorBadgeIssued:       `${PACKAGE_ID}::omen_badge::AuditorBadgeIssued`,
  // omen_agent
  AgentBadgeMinted:         `${PACKAGE_ID}::omen_agent::AgentBadgeMinted`,
  AgentSlashed:             `${PACKAGE_ID}::omen_agent::AgentSlashed`,
  AgentDeactivated:         `${PACKAGE_ID}::omen_agent::AgentDeactivated`,
  AgentLogicUpdated:        `${PACKAGE_ID}::omen_agent::AgentLogicUpdated`,
  // router (confirmed module name — NOT omen_router)
  TrustGatePassed:          `${PACKAGE_ID}::router::TrustGatePassed`,
  TrustGateRejected:        `${PACKAGE_ID}::router::TrustGateRejected`,
  AutoPauseEvent:           `${PACKAGE_ID}::router::AutoPauseEvent`,
  GatedPoolCreated:         `${PACKAGE_ID}::router::GatedPoolCreated`,
  PoolSuspended:            `${PACKAGE_ID}::router::PoolSuspended`,
  CircuitReset:             `${PACKAGE_ID}::router::CircuitReset`,
  AuditStaleRejected:       `${PACKAGE_ID}::router::AuditStaleRejected`,
  // vault
  VaultCreated:             `${PACKAGE_ID}::vault::VaultCreated`,
  Subscribed:               `${PACKAGE_ID}::vault::Subscribed`,
  EmergencyWithdraw:        `${PACKAGE_ID}::vault::EmergencyWithdraw`,
  CreatorWithdrew:          `${PACKAGE_ID}::vault::CreatorWithdrew`,
  EmergencyModeActivated:   `${PACKAGE_ID}::vault::EmergencyModeActivated`,
  EmergencyModeCleared:     `${PACKAGE_ID}::vault::EmergencyModeCleared`,
  // reviews
  ReviewSubmitted:          `${PACKAGE_ID}::reviews::ReviewSubmitted`,
  ReviewRemoved:            `${PACKAGE_ID}::reviews::ReviewRemoved`,
  // omen_type_registry
  PackageWhitelisted:       `${PACKAGE_ID}::omen_type_registry::PackageWhitelisted`,
  PackageRevoked:           `${PACKAGE_ID}::omen_type_registry::PackageRevoked`,
  PoolTypeRegistered:       `${PACKAGE_ID}::omen_type_registry::PoolTypeRegistered`,
  PoolTypeDeprecated:       `${PACKAGE_ID}::omen_type_registry::PoolTypeDeprecated`,
} as const;

// Confirmed module names from on-chain package query
export const POLL_MODULES = [
  "omen_registry",
  "omen_badge",
  "omen_agent",
  "router",
  "vault",
  "reviews",
  "omen_type_registry",
] as const;

// ---------------------------------------------------------------------------
// Struct types
// ---------------------------------------------------------------------------

export const STRUCT_TYPES = {
  OmenBadge:    `${PACKAGE_ID}::omen_badge::OmenBadge`,
  AdminCap:     `${PACKAGE_ID}::omen_registry::AdminCap`,
  AuditorBadge: `${PACKAGE_ID}::omen_badge::AuditorBadge`,
  AgentBadge:   `${PACKAGE_ID}::omen_agent::AgentBadge`,
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
export const SDK_TIMEOUT_MS = 2_000;

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