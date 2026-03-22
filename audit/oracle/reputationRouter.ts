/**
 * ============================================================
 * OMEN PROTOCOL — Reputation-Weighted Routing Engine
 * ============================================================
 * AI agents and trading bots that hold high-score OmenBadges
 * receive prioritized execution and reduced fee tiers when
 * routing through Omen's DeepBook gated pools.
 *
 * This module:
 *   1. Reads an agent's OmenBadge trust score from the Sui RPC
 *   2. Calculates their fee tier and execution priority
 *   3. Constructs the optimal transaction routing the order
 *      through the correct OmenPoolConfig
 *   4. Returns the transaction for signing by the AI agent
 *      (who authenticates via zkLogin from Phase 4)
 *
 * The psychology: AI agent developers will refuse to trade
 * outside Omen because the badge mathematically increases
 * their bot's profit margins through fee discounts.
 * ============================================================
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Network = "mainnet" | "testnet" | "devnet";

export interface AgentProfile {
  suiAddress:      string;
  isVerified:      boolean;
  trustScore:      number;    // 0-100
  isActive:        boolean;
  feeTierBps:      number;    // fee in basis points this agent pays
  priorityLevel:   PriorityLevel;
  maxLeverage:     number;    // multiplier (e.g. 3 = 3x leverage allowed)
  rebateBps:       number;    // maker rebate in basis points
  tierLabel:       TierLabel;
}

export type PriorityLevel = "ULTRA" | "HIGH" | "STANDARD" | "RESTRICTED";
export type TierLabel     = "Sovereign" | "Verified" | "Standard" | "Restricted";

export interface RoutingDecision {
  poolConfigId:    string;
  agentProfile:    AgentProfile;
  estimatedFee:    bigint;    // in base units
  priorityLevel:   PriorityLevel;
  transaction:     Transaction;
  reasoning:       string;
}

// ---------------------------------------------------------------------------
// Fee Tier Configuration
// ---------------------------------------------------------------------------
// Tier thresholds based on trust score. Agents are financially incentivized
// to maintain their score — every 10 points saves real money in fees.
// ---------------------------------------------------------------------------

interface FeeTier {
  label:         TierLabel;
  minScore:      number;
  feeBps:        number;   // trading fee (basis points of notional)
  rebateBps:     number;   // maker rebate
  priorityLevel: PriorityLevel;
  maxLeverage:   number;
  description:   string;
}

const FEE_TIERS: FeeTier[] = [
  {
    label:         "Sovereign",
    minScore:      95,
    feeBps:        2,      // 0.02% — institutional grade
    rebateBps:     5,      // 0.05% maker rebate
    priorityLevel: "ULTRA",
    maxLeverage:   10,
    description:   "Top 5% agents. Effectively subsidized by the protocol.",
  },
  {
    label:         "Verified",
    minScore:      80,
    feeBps:        5,      // 0.05%
    rebateBps:     3,      // 0.03% maker rebate
    priorityLevel: "HIGH",
    maxLeverage:   5,
    description:   "Proven track record. Meaningful fee advantage over retail.",
  },
  {
    label:         "Standard",
    minScore:      70,
    feeBps:        10,     // 0.10% — baseline for gated pool access
    rebateBps:     0,
    priorityLevel: "STANDARD",
    maxLeverage:   3,
    description:   "Verified but early. Must maintain score to upgrade.",
  },
  {
    label:         "Restricted",
    minScore:      0,
    feeBps:        25,     // 0.25% — penalized rate for low-score agents
    rebateBps:     0,
    priorityLevel: "RESTRICTED",
    maxLeverage:   1,
    description:   "Score too low for gated pools. Routed to public pools only.",
  },
];

function getTierForScore(score: number): FeeTier {
  // Tiers are ordered highest to lowest — return first match
  for (const tier of FEE_TIERS) {
    if (score >= tier.minScore) return tier;
  }
  return FEE_TIERS[FEE_TIERS.length - 1]!;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PACKAGE_ID   = process.env.OMEN_PACKAGE_ID!;
const REGISTRY_ID  = process.env.OMEN_REGISTRY_ID!;
const NETWORK: Network = (process.env.SUI_NETWORK ?? "testnet") as Network;

// Pool configs indexed by asset pair for quick lookup
// Populated via loadPoolConfigs() at startup
const POOL_CONFIG_REGISTRY = new Map<string, string>(); // "BASE/QUOTE" → poolConfigId

// ---------------------------------------------------------------------------
// Agent Profile Resolution
// ---------------------------------------------------------------------------

export async function resolveAgentProfile(
  suiAddress: string
): Promise<AgentProfile> {
  const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

  // Find the agent's OmenBadge
  const ownedObjects = await client.getOwnedObjects({
    owner: suiAddress,
    filter: { StructType: `${PACKAGE_ID}::omen_registry::OmenBadge` },
    options: { showContent: true },
  });

  if (!ownedObjects.data.length) {
    // No badge — restricted access, public pools only
    return {
      suiAddress,
      isVerified:    false,
      trustScore:    0,
      isActive:      false,
      feeTierBps:    FEE_TIERS[FEE_TIERS.length - 1]!.feeBps,
      priorityLevel: "RESTRICTED",
      maxLeverage:   1,
      rebateBps:     0,
      tierLabel:     "Restricted",
    };
  }

  const badge   = ownedObjects.data[0]!;
  const badgeId = badge.data?.objectId!;

  // Fetch dynamic fields for trust score and active status
  const dfs = await client.getDynamicFields({ parentId: badgeId });
  const dfMap: Record<string, unknown> = {};

  await Promise.all(
    dfs.data.map(async (df) => {
      const obj = await client.getDynamicFieldObject({
        parentId: badgeId,
        name:     df.name,
      });
      const content = obj.data?.content;
      if (content && content.dataType === "moveObject") {
        const fields = content.fields as Record<string, unknown>;
        dfMap[df.name.type] = fields.value;
      }
    })
  );

  const k            = `${PACKAGE_ID}::omen_registry`;
  const trustScore   = Number(dfMap[`${k}::TrustScoreKey`]  ?? 0);
  const isActive     = Boolean(dfMap[`${k}::IsActiveKey`]   ?? false);

  const tier = getTierForScore(isActive ? trustScore : 0);

  console.log(
    `[Router] Agent ${suiAddress}: score=${trustScore}, tier=${tier.label}, ` +
    `fee=${tier.feeBps}bps, priority=${tier.priorityLevel}`
  );

  return {
    suiAddress,
    isVerified:    true,
    trustScore,
    isActive,
    feeTierBps:    tier.feeBps,
    priorityLevel: tier.priorityLevel,
    maxLeverage:   tier.maxLeverage,
    rebateBps:     tier.rebateBps,
    tierLabel:     tier.label,
  };
}

// ---------------------------------------------------------------------------
// Route Order
// ---------------------------------------------------------------------------

export interface OrderParams {
  baseAsset:    string;      // e.g. "SUI"
  quoteAsset:   string;      // e.g. "USDsui"
  isBid:        boolean;     // true = buy base, false = sell base
  price:        bigint;      // DeepBook price units
  quantity:     bigint;      // base asset units
  clientOrderId: number;
  isImmediateOrCancel: boolean;
}

export async function routeOrder(
  agentAddress: string,
  order:        OrderParams
): Promise<RoutingDecision> {
  const profile    = await resolveAgentProfile(agentAddress);
  const pairKey    = `${order.baseAsset}/${order.quoteAsset}`;
  const poolConfigId = POOL_CONFIG_REGISTRY.get(pairKey);

  if (!poolConfigId) {
    throw new Error(
      `No Omen gated pool found for pair ${pairKey}. ` +
      `Available pairs: ${[...POOL_CONFIG_REGISTRY.keys()].join(", ")}`
    );
  }

  if (profile.priorityLevel === "RESTRICTED") {
    throw new Error(
      `Agent ${agentAddress} has trust score ${profile.trustScore} — ` +
      `below minimum 70 required for Omen gated pool access. ` +
      `Improve your score or use a public DeepBook pool.`
    );
  }

  // Estimate fee
  const notional      = order.price * order.quantity;
  const estimatedFee  = (notional * BigInt(profile.feeTierBps)) / 10000n;
  const makerRebate   = (notional * BigInt(profile.rebateBps)) / 10000n;
  const netFee        = estimatedFee - makerRebate;

  // Build the Move call
  const tx = new Transaction();

  const moveTarget = order.isBid
    ? `${PACKAGE_ID}::omen_deepbook::place_verified_bid`
    : `${PACKAGE_ID}::omen_deepbook::place_verified_ask`;

  // The type parameters would be resolved from asset names in production.
  // Here we construct the call with the correct argument order matching
  // the Move function signature.
  tx.moveCall({
    target: moveTarget,
    typeArguments: [
      `${PACKAGE_ID}::assets::${order.baseAsset}`,
      `${PACKAGE_ID}::assets::${order.quoteAsset}`,
    ],
    arguments: [
      tx.object(poolConfigId),           // config: &mut OmenPoolConfig
      tx.object(REGISTRY_ID),            // registry: &OmenRegistry
      // badge object ID must be resolved by the caller and passed in
      tx.object("BADGE_OBJECT_ID"),      // badge: &OmenBadge
      tx.object("DEEPBOOK_POOL_ID"),     // pool: &mut Pool<Base, Quote>
      tx.pure.u64(order.clientOrderId),
      tx.pure.u64(Number(order.price)),
      tx.pure.u64(Number(order.quantity)),
      tx.pure.bool(order.isImmediateOrCancel),
      tx.object("0x6"),                  // clock
    ],
  });

  tx.setSender(agentAddress);

  const reasoning =
    `Agent tier: ${profile.tierLabel} (score ${profile.trustScore}/100). ` +
    `Fee: ${profile.feeTierBps}bps` +
    (profile.rebateBps > 0 ? ` with ${profile.rebateBps}bps maker rebate` : "") +
    `. Priority: ${profile.priorityLevel}. ` +
    `Estimated net fee: ${netFee} base units. ` +
    `Max leverage allowed: ${profile.maxLeverage}x.`;

  console.log(`[Router] Order routed. ${reasoning}`);

  return {
    poolConfigId,
    agentProfile: profile,
    estimatedFee: netFee,
    priorityLevel: profile.priorityLevel,
    transaction: tx,
    reasoning,
  };
}

// ---------------------------------------------------------------------------
// Load Pool Configs at Startup
// ---------------------------------------------------------------------------

export async function loadPoolConfigs(
  poolConfigIds: Array<{ id: string; baseAsset: string; quoteAsset: string }>
): Promise<void> {
  for (const config of poolConfigIds) {
    const key = `${config.baseAsset}/${config.quoteAsset}`;
    POOL_CONFIG_REGISTRY.set(key, config.id);
    console.log(`[Router] Registered pool ${key} → ${config.id}`);
  }
}

// ---------------------------------------------------------------------------
// Fee Comparison Report (for agent dashboards / pitch demos)
// ---------------------------------------------------------------------------

export function generateFeeReport(score: number): string {
  const lines: string[] = [
    "═══════════════════════════════════════════",
    "  OMEN PROTOCOL — Agent Fee Tier Report",
    "═══════════════════════════════════════════",
    "",
  ];

  for (const tier of FEE_TIERS) {
    const isCurrentTier = score >= tier.minScore &&
      (FEE_TIERS.indexOf(tier) === 0 ||
       score < FEE_TIERS[FEE_TIERS.indexOf(tier) - 1]!.minScore);

    const marker = isCurrentTier ? "▶ " : "  ";
    lines.push(
      `${marker}${tier.label.padEnd(12)} ` +
      `Score ≥ ${String(tier.minScore).padEnd(4)} ` +
      `Fee: ${tier.feeBps}bps  ` +
      `Rebate: ${tier.rebateBps}bps  ` +
      `Leverage: ${tier.maxLeverage}x  ` +
      `Priority: ${tier.priorityLevel}`
    );
  }

  lines.push("");
  lines.push(`Current Score: ${score}`);
  lines.push(`Current Tier:  ${getTierForScore(score).label}`);
  lines.push("═══════════════════════════════════════════");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI Demo
// ---------------------------------------------------------------------------

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const address = process.argv[2] ?? "0xdemo";
  console.log("\nFee tier breakdown for all trust scores:\n");
  for (let score = 100; score >= 0; score -= 10) {
    const tier = getTierForScore(score);
    console.log(
      `Score ${String(score).padStart(3)}: ${tier.label.padEnd(12)} ` +
      `${tier.feeBps}bps fee, ${tier.maxLeverage}x max leverage`
    );
  }
  console.log();
}
