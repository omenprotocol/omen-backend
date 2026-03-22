/**
 * ============================================================
 * OMEN BACKEND API — src/walrus/fetcher.ts
 * ============================================================
 * Retrieves audit report JSON from Walrus decentralized storage
 * using the Blob ID stored on an OmenBadge.
 * Used by the MCP server's fetch_walrus_audit tool and the
 * REST API's GET /v1/audit/:blobId endpoint.
 * ============================================================
 */

import type { AuditReport } from "../oracle/auditor.js";

const WALRUS_AGGREGATOR_URL =
  process.env.WALRUS_AGGREGATOR_URL ?? "https://aggregator-devnet.walrus.space";

export async function fetchAuditReport(blobId: string): Promise<AuditReport> {
  console.log(`[Walrus/Fetcher] Fetching blob ${blobId}...`);

  const response = await fetch(`${WALRUS_AGGREGATOR_URL}/v1/${blobId}`);

  if (!response.ok) {
    throw new Error(
      `Walrus fetch failed (HTTP ${response.status}) for blob ${blobId}`
    );
  }

  const text = await response.text();
  console.log(`[Walrus/Fetcher] ✅ Retrieved ${text.length}b`);
  return JSON.parse(text) as AuditReport;
}
