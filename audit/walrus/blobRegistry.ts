/**
 * ============================================================
 * OMEN BACKEND — src/walrus/blobRegistry.ts
 * ============================================================
 * Module 7: Walrus Blob Service
 *
 * Responsibilities:
 *   • Track blob_id + expiry date per creator address
 *   • Blobs expire every 6 months — auto-renew from escrow
 *   • If blob becomes unresolvable → flag badge_status as
 *     'metadata_unavailable' (NOT deleted, clearly flagged)
 *   • Watchdog runs every 24 hours
 *   • Expiring blobs (< 14 days) are renewed first
 *
 * Currency: USDC on testnet. USDsui at mainnet (single swap).
 * ============================================================
 */

import type { Pool } from "pg";
import { createClient } from "redis";
type RedisClientType = ReturnType<typeof createClient>;
import { uploadAuditReport } from "./publisher.js";
import { fetchAuditReport }  from "./fetcher.js";
import type { AuditReport }  from "../oracle/auditor.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BLOB_TTL_MONTHS          = 6;
const EXPIRY_WARNING_DAYS      = 14;   // start renewal 14 days before expiry
const WATCHDOG_INTERVAL_MS     = 24 * 60 * 60 * 1000; // 24h
const MAX_RENEWAL_ATTEMPTS     = 3;
const WALRUS_VERIFY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlobRecord {
  id:              number;
  creatorAddress:  string;
  blobId:          string;
  expiryDate:      Date;
  autoRenew:       boolean;
  status:          "active" | "expiring_soon" | "expired" | "metadata_unavailable";
  renewalAttempts: number;
}

// ---------------------------------------------------------------------------
// Register a new blob after upload (called from audit pipeline)
// ---------------------------------------------------------------------------

export async function registerBlob(
  creatorAddress: string,
  blobId:         string,
  pg:             Pool
): Promise<void> {
  const expiryDate = new Date();
  expiryDate.setMonth(expiryDate.getMonth() + BLOB_TTL_MONTHS);

  await pg.query(
    `INSERT INTO blob_registry (creator_address, blob_id, expiry_date, status, last_verified_at)
     VALUES ($1, $2, $3, 'active', NOW())
     ON CONFLICT (blob_id) DO UPDATE SET
       expiry_date = $3,
       status = 'active',
       renewal_attempts = 0,
       last_verified_at = NOW(),
       updated_at = NOW()`,
    [creatorAddress, blobId, expiryDate.toISOString()]
  );

  console.log(
    `[BlobRegistry] Registered blob ${blobId.slice(0, 10)}... for ${creatorAddress.slice(0, 10)}...` +
    ` Expires: ${expiryDate.toDateString()}`
  );
}

// ---------------------------------------------------------------------------
// Verify a blob is resolvable from Walrus
// ---------------------------------------------------------------------------

async function verifyBlob(blobId: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), WALRUS_VERIFY_TIMEOUT_MS);

  try {
    await fetchAuditReport(blobId);
    clearTimeout(timeout);
    return true;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Flag a badge as metadata_unavailable (Module 7 requirement)
// ---------------------------------------------------------------------------

async function flagMetadataUnavailable(
  creatorAddress: string,
  blobId:         string,
  pg:             Pool,
  redis:          RedisClientType
): Promise<void> {
  // Update blob_registry
  await pg.query(
    `UPDATE blob_registry SET status = 'metadata_unavailable', updated_at = NOW()
     WHERE blob_id = $1`,
    [blobId]
  );

  // Update creator_profiles — badge_status clearly flagged, NOT deleted
  await pg.query(
    `UPDATE creator_profiles SET badge_status = 'metadata_unavailable', updated_at = NOW()
     WHERE address = $1`,
    [creatorAddress]
  );

  // Invalidate cache so next read reflects unavailability
  await redis.del(`omen:profile:${creatorAddress}`);

  console.warn(
    `[BlobRegistry] FLAGGED metadata_unavailable: address=${creatorAddress.slice(0, 10)}...` +
    ` blob=${blobId.slice(0, 10)}...`
  );
}

// ---------------------------------------------------------------------------
// Attempt to renew a blob by re-uploading the audit report
// ---------------------------------------------------------------------------

async function renewBlob(
  record: BlobRecord,
  pg:     Pool,
  redis:  RedisClientType
): Promise<void> {
  console.log(
    `[BlobRegistry] Attempting renewal for ${record.creatorAddress.slice(0, 10)}...` +
    ` blob=${record.blobId.slice(0, 10)}... (attempt ${record.renewalAttempts + 1}/${MAX_RENEWAL_ATTEMPTS})`
  );

  if (record.renewalAttempts >= MAX_RENEWAL_ATTEMPTS) {
    console.error(
      `[BlobRegistry] Max renewal attempts reached for blob ${record.blobId.slice(0, 10)}...` +
      ` Flagging as metadata_unavailable.`
    );
    await flagMetadataUnavailable(record.creatorAddress, record.blobId, pg, redis);
    return;
  }

  try {
    // Fetch the existing audit report to re-upload
    const report: AuditReport = await fetchAuditReport(record.blobId);

    // Re-upload to Walrus — returns new blob_id with fresh TTL
    const uploadResult = await uploadAuditReport(report);
    const newBlobId    = uploadResult.blobId;
    const newExpiry    = new Date();
    newExpiry.setMonth(newExpiry.getMonth() + BLOB_TTL_MONTHS);

    // Update blob_registry with new blob_id and expiry
    await pg.query(
      `UPDATE blob_registry
       SET blob_id = $1, expiry_date = $2, status = 'active',
           renewal_attempts = 0, last_verified_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [newBlobId, newExpiry.toISOString(), record.id]
    );

    // Update creator profile with new blob_id
    await pg.query(
      `UPDATE creator_profiles
       SET walrus_blob_id = $1, badge_status = 'active', updated_at = NOW()
       WHERE address = $2`,
      [newBlobId, record.creatorAddress]
    );

    // Invalidate cache
    await redis.del(`omen:profile:${record.creatorAddress}`);

    console.log(
      `[BlobRegistry] ✅ Renewed: ${record.creatorAddress.slice(0, 10)}...` +
      ` New blob: ${newBlobId.slice(0, 10)}... Expires: ${newExpiry.toDateString()}`
    );

  } catch (err) {
    console.error(`[BlobRegistry] Renewal failed for blob ${record.blobId.slice(0, 10)}...:`, err);

    // Increment attempt counter
    await pg.query(
      `UPDATE blob_registry
       SET renewal_attempts = renewal_attempts + 1, updated_at = NOW()
       WHERE id = $1`,
      [record.id]
    );

    // After max attempts → flag unavailable
    if (record.renewalAttempts + 1 >= MAX_RENEWAL_ATTEMPTS) {
      await flagMetadataUnavailable(record.creatorAddress, record.blobId, pg, redis);
    }
  }
}

// ---------------------------------------------------------------------------
// Watchdog — runs every 24 hours
// ---------------------------------------------------------------------------

async function runWatchdog(pg: Pool, redis: RedisClientType): Promise<void> {
  const now     = new Date();
  const warning = new Date(now.getTime() + EXPIRY_WARNING_DAYS * 24 * 3600 * 1000);

  console.log("[BlobRegistry] Watchdog running...");

  try {
    // 1. Find blobs expiring within 14 days that have auto_renew = true
    const expiringSoon = await pg.query(
      `SELECT id, creator_address, blob_id, expiry_date, auto_renew, status, renewal_attempts
       FROM blob_registry
       WHERE status IN ('active', 'expiring_soon')
         AND auto_renew = TRUE
         AND expiry_date <= $1
       ORDER BY expiry_date ASC`,
      [warning.toISOString()]
    );

    for (const row of expiringSoon.rows) {
      const record: BlobRecord = {
        id:              row.id,
        creatorAddress:  row.creator_address,
        blobId:          row.blob_id,
        expiryDate:      new Date(row.expiry_date),
        autoRenew:       row.auto_renew,
        status:          row.status,
        renewalAttempts: row.renewal_attempts,
      };

      // Mark as expiring_soon first
      if (record.status === "active") {
        await pg.query(
          `UPDATE blob_registry SET status = 'expiring_soon', updated_at = NOW() WHERE id = $1`,
          [record.id]
        );
      }

      await renewBlob(record, pg, redis);
    }

    // 2. Verify still-active blobs that haven't been verified in 7 days
    const toVerify = await pg.query(
      `SELECT id, creator_address, blob_id, expiry_date, auto_renew, status, renewal_attempts
       FROM blob_registry
       WHERE status = 'active'
         AND (last_verified_at IS NULL OR last_verified_at < NOW() - interval '7 days')
       LIMIT 50`
    );

    for (const row of toVerify.rows) {
      const isResolvable = await verifyBlob(row.blob_id);

      if (isResolvable) {
        await pg.query(
          `UPDATE blob_registry SET last_verified_at = NOW() WHERE id = $1`,
          [row.id]
        );
      } else {
        console.warn(`[BlobRegistry] Blob ${row.blob_id.slice(0, 10)}... unresolvable — flagging`);
        await flagMetadataUnavailable(row.creator_address, row.blob_id, pg, redis);
      }
    }

    console.log(
      `[BlobRegistry] Watchdog complete. ` +
      `Renewed: ${expiringSoon.rows.length}, Verified: ${toVerify.rows.length}`
    );

  } catch (err) {
    console.error("[BlobRegistry] Watchdog error:", err);
  }
}

// ---------------------------------------------------------------------------
// Entry point — called from index.ts
// ---------------------------------------------------------------------------

export async function startBlobWatchdog(pg: Pool, redis: RedisClientType): Promise<void> {
  console.log("[BlobRegistry] Blob watchdog starting...");

  // Run immediately on boot, then every 24h
  await runWatchdog(pg, redis);
  setInterval(() => runWatchdog(pg, redis), WATCHDOG_INTERVAL_MS);
}