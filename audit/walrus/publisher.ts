/**
 * ============================================================
 * OMEN BACKEND API — src/walrus/publisher.ts
 * ============================================================
 * Uploads audit report JSON to Walrus decentralized storage.
 * Returns the Blob ID that gets anchored on-chain via
 * registry::verify_and_update_badge.
 * ============================================================
 */

import type { AuditReport } from "../oracle/auditor.js";

const WALRUS_PUBLISHER_URL =
  process.env.WALRUS_PUBLISHER_URL ?? "https://publisher-devnet.walrus.space";

export interface WalrusUploadResult {
  blobId:    string;
  objectId:  string;
  endEpoch:  number;
  cost:      number;
}

export async function uploadAuditReport(
  report: AuditReport
): Promise<WalrusUploadResult> {
  const payload = JSON.stringify(report, null, 2);
  const bytes   = new TextEncoder().encode(payload);

  console.log(`[Walrus/Publisher] Uploading ${bytes.length}b for ${report.packageId}...`);

  const response = await fetch(`${WALRUS_PUBLISHER_URL}/v1/store`, {
    method:  "PUT",
    headers: {
      "Content-Type":   "application/octet-stream",
      "Content-Length": bytes.length.toString(),
    },
    body: bytes,
  });

  if (!response.ok) {
    throw new Error(
      `Walrus upload failed (HTTP ${response.status}): ${await response.text()}`
    );
  }

  const result = await response.json();

  if (result.newlyCreated) {
    const blob = result.newlyCreated.blobObject;
    console.log(`[Walrus/Publisher] ✅ New blob: ${blob.blobId}`);
    return {
      blobId:   blob.blobId,
      objectId: blob.id,
      endEpoch: blob.storage.endEpoch,
      cost:     result.newlyCreated.cost ?? 0,
    };
  }

  if (result.alreadyCertified) {
    console.log(`[Walrus/Publisher] ✅ Already stored: ${result.alreadyCertified.blobId}`);
    return {
      blobId:   result.alreadyCertified.blobId,
      objectId: result.alreadyCertified.event?.objectId ?? "",
      endEpoch: result.alreadyCertified.endEpoch ?? 0,
      cost:     0,
    };
  }

  throw new Error(`Unexpected Walrus response: ${JSON.stringify(result)}`);
}
