/**
 * ============================================================
 * OMEN BACKEND — src/indexer/eventListener.ts
 * ============================================================
 * Dual-track event ingestion:
 *   1. WebSocket subscription (real-time, low latency)
 *   2. Polling fallback (gap coverage on WS disconnect)
 *
 * Module 2 rules enforced:
 *   • Cursor persisted after EVERY event — no loss on reboot
 *   • SlashExecuted → DB update + Redis invalidation < 500ms
 *   • ZKAuditVerified → audit_ledger APPEND ONLY
 *   • WebSocket reconnects automatically; polling covers the gap
 *   • Polls ALL event-emitting modules (not just omen_registry)
 * ============================================================
 */

import { WebSocket } from "ws";
// @ts-ignore
globalThis.WebSocket = WebSocket;

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import type { SuiEvent, EventId } from "@mysten/sui/client";
import { createClient } from "redis";
type RedisClientType = ReturnType<typeof createClient>;

import {
  upsertCreatorProfile,
  updateTrustScore,
  updateRiskScore,
  updateProjectLocked,
  insertReview,
  insertPeerReview,
  removePeerReview,
  recordGatedTrade,
  appendAuditLedger,
  handleSlashExecuted,
  updateApplicationStatus,
  saveLastCursor,
  loadLastCursor,
} from "./dbUpsert.js";
import { pool } from "../../index.js";

import { PACKAGE_ID, NETWORK, EVENTS, POLL_MODULES } from "../../config.js";

const POLL_INTERVAL_MS  = 5_000;
const WS_RECONNECT_MS   = 10_000;
const SLASH_INVALIDATION_TIMEOUT_MS = 500;

const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

let redisClient: RedisClientType;

// ---------------------------------------------------------------------------
// Event type map — imported from config
// ---------------------------------------------------------------------------

const E = EVENTS;

// ---------------------------------------------------------------------------
// Suppress noisy WebSocket errors
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  if (
    err.message.includes("405") ||
    err.message.includes("WebSocket") ||
    err.message.includes("ECONNREFUSED")
  ) return;
  console.error("[Indexer] Uncaught exception:", err);
});

// ---------------------------------------------------------------------------
// Redis cache invalidation (Module 3)
// ---------------------------------------------------------------------------

async function invalidateAddressCache(address: string): Promise<void> {
  try {
    const deadline = Date.now() + SLASH_INVALIDATION_TIMEOUT_MS;
    await redisClient.del(`omen:profile:${address}`);
    const elapsed = Date.now() - (deadline - SLASH_INVALIDATION_TIMEOUT_MS);
    if (elapsed > SLASH_INVALIDATION_TIMEOUT_MS) {
      console.error(
        `[Indexer] WARN: Cache invalidation for ${address.slice(0, 10)} took ${elapsed}ms — exceeded 500ms SLA`
      );
    } else {
      console.log(`[Indexer] Cache invalidated for ${address.slice(0, 10)}... (${elapsed}ms)`);
    }
  } catch (err) {
    console.error("[Indexer] Redis invalidation error:", err);
  }
}

// ---------------------------------------------------------------------------
// Core event handler
// ---------------------------------------------------------------------------

async function handleEvent(event: SuiEvent): Promise<void> {
  const type     = event.type;
  const e        = event.parsedJson as Record<string, any>;
  const txDigest = event.id.txDigest;

  try {
    // ── omen_registry ──────────────────────────────────────────────────────

    if (type === E.CreatorVerified) {
      await upsertCreatorProfile({
        address:      e.creator_address,
        badgeId:      e.badge_id,
        name:         e.creator_name,
        tier:         Number(e.tier ?? 0),
        isVerified:   true,
        isActive:     true,
        trustScore:   Number(e.initial_score ?? 0),
        riskScore:    0,
        walrusBlobId: "",
        issueDate:    Number(e.timestamp ?? 0),
      });
      console.log(`[Indexer] CreatorVerified: ${e.creator_address?.slice(0, 10)}...`);

    } else if (type === E.CreatorRevoked) {
      await pool.query(
        `UPDATE creator_profiles
         SET is_verified = FALSE, revoked_at = $1, badge_status = 'revoked', updated_at = NOW()
         WHERE address = $2`,
        [Number(e.timestamp ?? 0), e.creator_address]
      );
      await invalidateAddressCache(e.creator_address);
      console.log(`[Indexer] CreatorRevoked: ${e.creator_address?.slice(0, 10)}...`);

    } else if (type === E.TrustScoreUpdated) {
      await updateTrustScore(e.creator_address, Number(e.new_score));
      await invalidateAddressCache(e.creator_address);
      console.log(`[Indexer] TrustScoreUpdated: ${e.creator_address?.slice(0, 10)}... → ${e.new_score}`);

    } else if (type === E.StatusChanged) {
      await pool.query(
        `UPDATE creator_profiles SET is_active = $1, updated_at = NOW() WHERE address = $2`,
        [Boolean(e.is_active), e.creator_address]
      );
      await invalidateAddressCache(e.creator_address);
      console.log(`[Indexer] StatusChanged: ${e.creator_address?.slice(0, 10)}... active=${e.is_active}`);

    } else if (type === E.SlashExecuted) {
      // Module 2 + 3: DB update AND Redis invalidation must both complete
      // Cache invalidation is time-critical — do it first, then DB
      const invalidateStart = Date.now();
      await invalidateAddressCache(e.creator_address);
      const invalidateMs = Date.now() - invalidateStart;

      if (invalidateMs > SLASH_INVALIDATION_TIMEOUT_MS) {
        console.error(
          `[Indexer] CRITICAL: SlashExecuted cache invalidation took ${invalidateMs}ms for ` +
          `${e.creator_address?.slice(0, 10)}. SLA BREACHED.`
        );
      }

      await handleSlashExecuted({
        address:   e.creator_address,
        txDigest,
        timestamp: Number(e.timestamp ?? Date.now()),
        newScore:  e.new_score !== undefined ? Number(e.new_score) : undefined,
      });
      console.log(`[Indexer] SlashExecuted: ${e.creator_address?.slice(0, 10)}... invalidated in ${invalidateMs}ms`);

    } else if (type === E.ApplicationSubmitted) {
      await pool.query(
        `INSERT INTO applications (applicant, entity_type, name, paid_amount, status, applied_at, tx_digest)
         VALUES ($1,$2,$3,$4,'pending',$5,$6)
         ON CONFLICT (applicant) DO UPDATE SET
           status = 'pending', tx_digest = EXCLUDED.tx_digest`,
        [e.applicant, Number(e.entity_type ?? 0), e.name, Number(e.paid_amount ?? 0),
         Number(e.timestamp ?? 0), txDigest]
      );
      console.log(`[Indexer] ApplicationSubmitted: ${e.applicant?.slice(0, 10)}...`);

    } else if (type === E.ApplicationApproved) {
      await updateApplicationStatus(txDigest, "approved");
      console.log(`[Indexer] ApplicationApproved tx=${txDigest.slice(0, 10)}...`);

    } else if (type === E.ApplicationRejected) {
      await updateApplicationStatus(txDigest, "rejected");
      console.log(`[Indexer] ApplicationRejected tx=${txDigest.slice(0, 10)}...`);

    // ── omen_badge ─────────────────────────────────────────────────────────

    } else if (type === E.ReviewPosted) {
      await insertReview({
        creatorAddress: e.creator_address,
        reviewer:       e.reviewer,
        rating:         Number(e.rating),
        timestamp:      Number(e.timestamp ?? 0),
        txDigest,
      });
      console.log(`[Indexer] ReviewPosted on ${e.creator_address?.slice(0, 10)}...`);

    } else if (type === E.ProjectLocked) {
      await updateProjectLocked(e.creator_address, true);
      await invalidateAddressCache(e.creator_address);
      console.log(`[Indexer] ProjectLocked: ${e.creator_address?.slice(0, 10)}...`);

    } else if (type === E.RiskScoreIssued) {
      await updateRiskScore(e.creator_address, Number(e.risk_score));
      await pool.query(
        `UPDATE creator_profiles SET walrus_blob_id = $1, updated_at = NOW() WHERE address = $2`,
        [e.blob_id ?? "", e.creator_address]
      );
      await invalidateAddressCache(e.creator_address);
      console.log(`[Indexer] RiskScoreIssued: ${e.creator_address?.slice(0, 10)}... score=${e.risk_score}`);

    } else if (type === E.ZKAuditVerified) {
      // APPEND ONLY to audit_ledger — never overwrite historical records
      await appendAuditLedger({
        creatorAddress: e.creator_address,
        packageId:      e.package_id ?? PACKAGE_ID,
        moduleName:     e.module_name ?? "",
        riskScore:      Number(e.risk_score),
        blobId:         e.blob_id ?? "",
        txDigest,
        auditedAt:      Number(e.timestamp ?? Date.now()),
      });
      // Also update the profile's latest risk score + blob
      await updateRiskScore(e.creator_address, Number(e.risk_score));
      await pool.query(
        `UPDATE creator_profiles SET walrus_blob_id = $1, updated_at = NOW() WHERE address = $2`,
        [e.blob_id ?? "", e.creator_address]
      );
      // Invalidate cache (Module 3)
      await invalidateAddressCache(e.creator_address);
      console.log(`[Indexer] ZKAuditVerified (appended): ${e.creator_address?.slice(0, 10)}... score=${e.risk_score}`);

    // ── reviews module ─────────────────────────────────────────────────────

    } else if (type === E.ReviewSubmitted) {
      await insertPeerReview({
        targetAddress:   e.target_address,
        reviewerAddress: e.reviewer_address,
        reviewerBadgeId: e.reviewer_badge_id,
        walrusBlobId:    e.walrus_blob_id ?? "",
        rating:          Number(e.rating),
        reviewerScore:   Number(e.reviewer_score ?? 0),
        timestamp:       Number(e.timestamp ?? 0),
      });
      console.log(`[Indexer] PeerReview submitted on ${e.target_address?.slice(0, 10)}...`);

    } else if (type === E.ReviewRemoved) {
      await removePeerReview(e.target_address ?? e.target_badge_id, e.reviewer_badge_id);
      console.log(`[Indexer] PeerReview removed: ${e.target_badge_id?.slice(0, 10)}...`);

    // ── router module ─────────────────────────────────────────────────

    } else if (type === E.TrustGatePassed) {
      await recordGatedTrade({
        traderAddress: e.trader,
        routerAddress: PACKAGE_ID,
        poolConfigId:  e.pool_config_id ?? null,
        tokenIn:       null,
        tokenOut:      null,
        amountIn:      Number(e.quantity ?? 0),
        amountOut:     0,
        quantity:      Number(e.quantity ?? 0),
        passedGate:    true,
        trustScore:    Number(e.trust_score ?? 0),
        timestamp:     Number(e.timestamp ?? 0),
        txDigest,
      });
      console.log(`[Indexer] TrustGatePassed: ${e.trader?.slice(0, 10)}...`);

    } else if (type === E.TrustGateRejected) {
      await recordGatedTrade({
        traderAddress: e.trader,
        routerAddress: PACKAGE_ID,
        poolConfigId:  e.pool_config_id ?? null,
        tokenIn:       null,
        tokenOut:      null,
        amountIn:      Number(e.quantity ?? 0),
        amountOut:     0,
        quantity:      Number(e.quantity ?? 0),
        passedGate:    false,
        trustScore:    Number(e.trust_score ?? 0),
        timestamp:     Number(e.timestamp ?? 0),
        txDigest,
      });
      console.log(`[Indexer] TrustGateRejected: ${e.trader?.slice(0, 10)}...`);

    } else if (type === E.AutoPauseEvent) {
      // Flag pool as paused in local state — circuit breaker triggered on-chain
      await pool.query(
        `UPDATE gated_trades
         SET passed_gate = FALSE
         WHERE pool_config_id = $1
           AND timestamp > (EXTRACT(EPOCH FROM NOW()) * 1000 - 300000)::BIGINT`,
        [e.pool_config_id ?? e.pool_id]
      );
      // Invalidate any cached pool stats
      await redisClient.del(`omen:pool:${e.pool_config_id ?? e.pool_id}`);
      console.warn(
        `[Indexer] AutoPauseEvent — pool ${(e.pool_config_id ?? e.pool_id)?.slice(0, 10)}... paused`
      );

    } else if (type === E.PoolSuspended) {
      await redisClient.del(`omen:pool:${e.pool_config_id ?? e.pool_id}`);
      console.warn(`[Indexer] PoolSuspended: ${(e.pool_config_id ?? e.pool_id)?.slice(0, 10)}...`);

    } else if (type === E.CircuitReset) {
      await redisClient.del(`omen:pool:${e.pool_config_id ?? e.pool_id}`);
      console.log(`[Indexer] CircuitReset: ${(e.pool_config_id ?? e.pool_id)?.slice(0, 10)}...`);

    } else if (type === E.AuditStaleRejected) {
      await redisClient.del(`omen:pool:${e.pool_config_id ?? e.pool_id}`);
      console.warn(`[Indexer] AuditStaleRejected: pool=${(e.pool_config_id ?? e.pool_id)?.slice(0, 10)}...`);

    // ── omen_agent module ──────────────────────────────────────────────────

    } else if (type === E.AgentBadgeMinted) {
      await pool.query(
        `INSERT INTO creator_profiles (address, badge_id, name, tier, is_verified, is_active, trust_score, risk_score, walrus_blob_id, issue_date, updated_at)
         VALUES ($1, $2, 'Agent', 0, true, true, $3, 0, '', $4, NOW())
         ON CONFLICT (address) DO UPDATE SET
           badge_id = $2, trust_score = $3, is_verified = true, is_active = true, updated_at = NOW()`,
        [e.agent_address, e.agent_badge_id, Number(e.trust_score ?? 0), Number(e.timestamp ?? 0)]
      );
      await invalidateAddressCache(e.agent_address);
      console.log(`[Indexer] AgentBadgeMinted: ${e.agent_address?.slice(0, 10)}...`);

    } else if (type === E.AgentSlashed) {
      await pool.query(
        `UPDATE creator_profiles SET trust_score = 0, badge_status = 'slashed', is_active = FALSE, updated_at = NOW()
         WHERE address = $1`,
        [e.agent_address]
      );
      await invalidateAddressCache(e.agent_address);
      console.warn(`[Indexer] AgentSlashed: ${e.agent_address?.slice(0, 10)}...`);

    } else if (type === E.AgentDeactivated) {
      await pool.query(
        `UPDATE creator_profiles SET is_active = FALSE, updated_at = NOW() WHERE address = $1`,
        [e.agent_address]
      );
      await invalidateAddressCache(e.agent_address);
      console.log(`[Indexer] AgentDeactivated: ${e.agent_address?.slice(0, 10)}...`);

    // ── omen_registry stake + bond events ─────────────────────────────────

    } else if (type === E.StakeDeposited) {
      console.log(`[Indexer] StakeDeposited: ${e.creator_address?.slice(0, 10)}... amount=${e.amount}`);

    } else if (type === E.StakeSlashed) {
      await invalidateAddressCache(e.creator_address);
      console.warn(`[Indexer] StakeSlashed: ${e.creator_address?.slice(0, 10)}...`);

    } else if (type === E.StakeReturned) {
      console.log(`[Indexer] StakeReturned: ${e.creator_address?.slice(0, 10)}...`);

    } else if (type === E.BondDeposited) {
      console.log(`[Indexer] BondDeposited: ${e.creator_address?.slice(0, 10)}... amount=${e.amount}`);

    } else if (type === E.BondSeized) {
      await invalidateAddressCache(e.creator_address);
      console.warn(`[Indexer] BondSeized: ${e.creator_address?.slice(0, 10)}...`);

    } else if (type === E.BondReleased) {
      console.log(`[Indexer] BondReleased: ${e.creator_address?.slice(0, 10)}...`);

    } else if (type === E.AuditorProposalCreated) {
      console.log(`[Indexer] AuditorProposalCreated: ${e.applicant?.slice(0, 10)}...`);

    } else if (type === E.AuditorProposalApproved) {
      console.log(`[Indexer] AuditorProposalApproved: ${e.applicant?.slice(0, 10)}...`);

    } else if (type === E.AuditorBadgeExecuted) {
      console.log(`[Indexer] AuditorBadgeExecuted: ${e.auditor_address?.slice(0, 10)}...`);

    // ── omen_badge recovery events ─────────────────────────────────────────

    } else if (type === E.RecoveryProposed) {
      console.log(`[Indexer] RecoveryProposed: ${e.creator_address?.slice(0, 10)}...`);

    } else if (type === E.RecoveryExecuted) {
      await invalidateAddressCache(e.creator_address);
      console.log(`[Indexer] RecoveryExecuted: ${e.creator_address?.slice(0, 10)}...`);

    } else if (type === E.RecoveryCancelled) {
      console.log(`[Indexer] RecoveryCancelled: ${e.creator_address?.slice(0, 10)}...`);

    // ── vault module ───────────────────────────────────────────────────────

    } else if (type === E.VaultCreated) {
      console.log(`[Indexer] VaultCreated: ${e.creator_address?.slice(0, 10)}... vault=${e.vault_id?.slice(0, 10)}...`);

    } else if (type === E.Subscribed) {
      console.log(`[Indexer] Subscribed to vault: ${e.vault_id?.slice(0, 10)}...`);

    } else if (type === E.EmergencyWithdraw) {
      console.warn(`[Indexer] EmergencyWithdraw: vault=${e.vault_id?.slice(0, 10)}...`);

    } else if (type === E.EmergencyModeActivated) {
      console.warn(`[Indexer] EmergencyModeActivated: vault=${e.vault_id?.slice(0, 10)}...`);

    } else if (type === E.EmergencyModeCleared) {
      console.log(`[Indexer] EmergencyModeCleared: vault=${e.vault_id?.slice(0, 10)}...`);
    }

  } catch (err) {
    console.error(`[Indexer] Error handling event ${type}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Polling loop — covers ALL modules, cursor-persisted (Module 2)
// ---------------------------------------------------------------------------

async function pollModule(moduleName: string, cursor: any): Promise<any> {
  const result = await client.queryEvents({
    query: { MoveEventModule: { package: PACKAGE_ID, module: moduleName } },
    cursor: cursor ?? undefined,
    order:  "ascending",
    limit:  50,
  });

  for (const event of result.data) {
    await handleEvent(event);
    // Persist cursor after EVERY event — spec requirement
    await saveLastCursor({ txDigest: event.id.txDigest, eventSeq: event.id.eventSeq });
  }

  return result.hasNextPage ? result.nextCursor : null;
}

async function pollForEvents(): Promise<void> {
  try {
    const cursor = await loadLastCursor();

    // Fan out across all modules in parallel
    const results = await Promise.allSettled(
      POLL_MODULES.map((mod) => pollModule(mod, cursor))
    );

    for (const r of results) {
      if (r.status === "rejected") {
        console.error("[Indexer] Poll module error:", r.reason);
      }
    }
  } catch (err) {
    console.error("[Indexer] Poll error:", err);
  }

  setTimeout(pollForEvents, POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// WebSocket — real-time push layer (Module 2 fallback spec)
// ---------------------------------------------------------------------------

let wsUnsubscribe: (() => Promise<void>) | null = null;
let wsActive = false;

async function startWebSocket(): Promise<void> {
  if (wsActive) return;

  try {
    console.log(`[Indexer] Starting WebSocket subscription for package ${PACKAGE_ID.slice(0, 10)}...`);

    wsUnsubscribe = await client.subscribeEvent({
      filter:    { Package: PACKAGE_ID },
      onMessage: async (event: SuiEvent) => {
        await handleEvent(event);
        // Persist cursor on every WS event too
        await saveLastCursor({
          txDigest: event.id.txDigest,
          eventSeq: event.id.eventSeq,
        });
      },
    });

    wsActive = true;
    console.log("[Indexer] WebSocket subscription active — real-time events enabled");

  } catch (err) {
    wsActive = false;
    console.warn(
      `[Indexer] WebSocket failed (${(err as Error).message}). ` +
      `Polling covers the gap. Retrying in ${WS_RECONNECT_MS / 1000}s...`
    );
    setTimeout(startWebSocket, WS_RECONNECT_MS);
  }
}

async function reconnectWebSocket(): Promise<void> {
  if (wsUnsubscribe) {
    try { await wsUnsubscribe(); } catch { /* ignore */ }
    wsUnsubscribe = null;
  }
  wsActive = false;
  setTimeout(startWebSocket, WS_RECONNECT_MS);
}

// ---------------------------------------------------------------------------
// Entry point — called from index.ts
// ---------------------------------------------------------------------------

export async function startEventListener(redis: RedisClientType): Promise<void> {
  redisClient = redis;

  console.log(`[Indexer] Starting on ${NETWORK} | Package: ${PACKAGE_ID.slice(0, 10)}...`);
  console.log(`[Indexer] Polling modules: ${POLL_MODULES.join(", ")}`);

  // Start polling loop (always runs — covers WS gaps)
  pollForEvents();

  // Start WebSocket (real-time layer on top)
  await startWebSocket();
}