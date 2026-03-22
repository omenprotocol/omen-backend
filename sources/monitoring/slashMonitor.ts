/**
 * ============================================================
 * OMEN BACKEND — src/monitoring/slashMonitor.ts
 * ============================================================
 * Module 8: Incident Response SLA
 *
 * Published SLA: detection-to-Trust-Score-update within 30 minutes
 * of a confirmed on-chain SlashExecuted event.
 *
 * This monitor:
 *   1. Polls slash_incidents for unresolved events
 *   2. Checks if the associated creator_profiles row has been
 *      updated (trust_score change is the resolution signal)
 *   3. Marks incidents resolved with resolution_ms recorded
 *   4. Fires an alert if the 30-minute window is breached
 *   5. Runs every 60 seconds
 *
 * Alert channels: console.error (extend to PagerDuty / Slack webhook
 * via SLACK_WEBHOOK_URL env var).
 * ============================================================
 */

import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SLA_WINDOW_MS      = 30 * 60 * 1_000;  // 30 minutes
const MONITOR_INTERVAL_MS = 60_000;           // check every 60 seconds
// Read at call time — not module load time — so dotenv has already run
function slackUrl():     string | undefined { return process.env.SLACK_WEBHOOK_URL; }
function pagerdutyKey(): string | undefined { return process.env.PAGERDUTY_ROUTING_KEY; }

// ---------------------------------------------------------------------------
// Alert dispatch
// ---------------------------------------------------------------------------

async function sendAlert(incident: {
  id:            number;
  targetAddress: string;
  txDigest:      string;
  detectedAt:    number;
  elapsedMs:     number;
}): Promise<void> {
  const webhookUrl  = process.env.SLACK_WEBHOOK_URL;
  const pdKey       = process.env.PAGERDUTY_ROUTING_KEY;
  const elapsedMin = (incident.elapsedMs / 60_000).toFixed(1);
  const message    =
    `🚨 OMEN SLA BREACH — SlashExecuted not resolved within 30 min\n` +
    `Address  : ${incident.targetAddress}\n` +
    `Tx       : ${incident.txDigest}\n` +
    `Elapsed  : ${elapsedMin} minutes\n` +
    `Incident : #${incident.id}\n` +
    `Action   : Check indexer health + DB write pipeline`;

  console.error(`[SlashMonitor] ALERT:\n${message}`);

  // Slack webhook
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: message }),
      });
    } catch (err) {
      console.error("[SlashMonitor] Slack alert failed:", err);
    }
  }

  // PagerDuty Events v2
  if (pdKey) {
    try {
      await fetch("https://events.pagerduty.com/v2/enqueue", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          routing_key:  pdKey!,
          event_action: "trigger",
          payload: {
            summary:   `Omen SLA breach: SlashExecuted unresolved after ${elapsedMin}min`,
            severity:  "critical",
            source:    "omen-slash-monitor",
            custom_details: {
              target_address: incident.targetAddress,
              tx_digest:      incident.txDigest,
              elapsed_ms:     incident.elapsedMs,
              incident_id:    incident.id,
            },
          },
          dedup_key: `omen-slash-${incident.txDigest}`,
        }),
      });
    } catch (err) {
      console.error("[SlashMonitor] PagerDuty alert failed:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution check — is the profile trust_score updated?
// ---------------------------------------------------------------------------

async function checkResolution(
  incidentId:    number,
  targetAddress: string,
  detectedAt:    number,
  pg:            Pool
): Promise<{ resolved: boolean; elapsedMs: number }> {
  const elapsedMs = Date.now() - detectedAt;

  // Check if profile has been updated since the slash was detected
  const result = await pg.query(
    `SELECT updated_at, badge_status
     FROM creator_profiles
     WHERE address = $1`,
    [targetAddress]
  );

  if (!result.rows.length) {
    return { resolved: false, elapsedMs };
  }

  const profile = result.rows[0];
  const updatedAt = new Date(profile.updated_at).getTime();

  // Resolution criteria: profile was updated AFTER the slash was detected
  // AND badge_status is 'slashed'
  const resolved =
    updatedAt >= detectedAt &&
    profile.badge_status === "slashed";

  return { resolved, elapsedMs };
}

// ---------------------------------------------------------------------------
// Main monitor loop
// ---------------------------------------------------------------------------

async function runMonitor(pg: Pool): Promise<void> {
  try {
    // Fetch all unresolved slash incidents
    const result = await pg.query(
      `SELECT id, target_address, tx_digest, detected_at
       FROM slash_incidents
       WHERE resolved_at IS NULL
       ORDER BY detected_at ASC`
    );

    for (const row of result.rows) {
      const incidentId   = row.id as number;
      const address      = row.target_address as string;
      const txDigest     = row.tx_digest as string;
      const detectedAt   = Number(row.detected_at);

      const { resolved, elapsedMs } = await checkResolution(
        incidentId, address, detectedAt, pg
      );

      if (resolved) {
        // Mark resolved
        await pg.query(
          `UPDATE slash_incidents
           SET resolved_at = $1, resolution_ms = $2, sla_breached = $3
           WHERE id = $4`,
          [
            Date.now(),
            elapsedMs,
            elapsedMs > SLA_WINDOW_MS,
            incidentId,
          ]
        );

        const slaBreached = elapsedMs > SLA_WINDOW_MS;
        const elapsedMin  = (elapsedMs / 60_000).toFixed(1);

        if (slaBreached) {
          console.error(
            `[SlashMonitor] ⚠️  SLA BREACHED — resolved in ${elapsedMin}min (limit: 30min) | ` +
            `address=${address.slice(0, 10)}...`
          );
        } else {
          console.log(
            `[SlashMonitor] ✅ Resolved in ${elapsedMin}min | address=${address.slice(0, 10)}...`
          );
        }
        continue;
      }

      // Still unresolved — check if SLA window has been breached
      if (elapsedMs > SLA_WINDOW_MS) {
        const alreadyAlerted = await pg.query(
          `SELECT alerted FROM slash_incidents WHERE id = $1`,
          [incidentId]
        );

        if (!alreadyAlerted.rows[0]?.alerted) {
          // Fire alert (once per incident)
          await sendAlert({ id: incidentId, targetAddress: address, txDigest, detectedAt, elapsedMs });

          await pg.query(
            `UPDATE slash_incidents SET sla_breached = TRUE, alerted = TRUE WHERE id = $1`,
            [incidentId]
          );
        }
      } else {
        // Still within window — log progress every check
        const remaining = Math.ceil((SLA_WINDOW_MS - elapsedMs) / 60_000);
        console.log(
          `[SlashMonitor] Pending: ${address.slice(0, 10)}... — ` +
          `${remaining}min remaining in SLA window`
        );
      }
    }

  } catch (err) {
    console.error("[SlashMonitor] Monitor error:", err);
  }
}

// ---------------------------------------------------------------------------
// Entry point — called from index.ts
// ---------------------------------------------------------------------------

export async function startSlashMonitor(
  pg:             Pool,
  slackWebhook?:  string,
  pagerdutyKey?:  string
): Promise<void> {
  console.log(
    `[SlashMonitor] Starting. SLA window: 30 minutes. ` +
    `Check interval: ${MONITOR_INTERVAL_MS / 1000}s`
  );

  if (slackWebhook) {
    console.log("[SlashMonitor] Slack alerts: enabled");
  }
  if (pagerdutyKey) {
    console.log("[SlashMonitor] PagerDuty alerts: enabled");
  }
  if (!slackWebhook && !pagerdutyKey) {
    console.warn("[SlashMonitor] No alert channel configured. Set SLACK_WEBHOOK_URL or PAGERDUTY_ROUTING_KEY.");
  }

  // Run immediately on boot
  await runMonitor(pg);

  // Then every 60 seconds
  setInterval(() => runMonitor(pg), MONITOR_INTERVAL_MS);
}
