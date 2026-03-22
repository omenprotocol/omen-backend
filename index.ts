/**
 * ============================================================
 * OMEN BACKEND — src/index.ts  (canonical entry point)
 * ============================================================
 * Merges app.ts + index.ts into one authoritative boot file.
 *
 * Wires together:
 *   • PostgreSQL + Redis connections
 *   • Schema migrations (initDB)
 *   • REST API routes (Express)
 *   • Cloudflare Turnstile gate (sponsored mint routes)
 *   • B2B API key middleware (badge read routes)
 *   • On-chain event indexer (Sui WebSocket + polling)
 *
 * The MCP server (src/mcp/server.ts) is a separate process —
 * NOT mounted here.
 * ============================================================
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import { Pool } from "pg";
import { createClient } from "redis";
type RedisClientType = ReturnType<typeof createClient>;
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

import {
  PORT,
  NETWORK,
  PACKAGE_ID,
  DATABASE_URL,
  REDIS_URL,
  validateConfig,
} from "./config.js";

import { profileRouter, initProfileRouter } from "./sources/api routes/getProfile.js";
import { initDB } from "./sources/indexer/dbUpsert.js";
import { startEventListener } from "./sources/indexer/eventListener.js";
import { turnstileMiddleware } from "./sources/middleware/turnstile.js";
import { apiKeyMiddleware, freeRateLimiter, initApiKeyMiddleware } from "./sources/middleware/apiKeyMiddleware.js";
import { startBlobWatchdog } from "./audit/walrus/blobRegistry.js";
import { startSlashMonitor } from "./sources/monitoring/slashMonitor.js";

// Run config validation — warns on missing non-critical vars, throws on fatal
validateConfig();

export const OMEN_PACKAGE_ID = PACKAGE_ID;

// ---------------------------------------------------------------------------
// Shared clients — exported so indexer + routers can import without
// creating new pool connections
// ---------------------------------------------------------------------------

export let pool: Pool;
export let suiClient: InstanceType<typeof SuiClient>;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Pool created here — after dotenv has run, password is resolved
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });

  // ── Redis ────────────────────────────────────────────────────────────────
  const redis = createClient({
    url: REDIS_URL,
  }) as RedisClientType;

  redis.on("error", (err) => console.error("[Redis] Client error:", err));
  await redis.connect();
  console.log("[Redis] Connected");

  // ── Database migrations ──────────────────────────────────────────────────
  await initDB();
  console.log("[DB] Schema ready");

  // ── Express ──────────────────────────────────────────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Inject shared clients into route handlers
  initProfileRouter(pool, redis);
  initApiKeyMiddleware(pool, redis);

  // ── Routes ───────────────────────────────────────────────────────────────

  // Health — no auth, public
  app.get("/health", (_req, res) => {
    res.json({
      status:    "ok",
      service:   "omen-backend",
      network:   NETWORK,
      package:   OMEN_PACKAGE_ID.slice(0, 10) + "...",
      timestamp: Date.now(),
    });
  });

  // Badge read endpoints — free tier (rate limited) + enterprise key path
  // GET /v1/badge/:address is the primary SDK-facing route (Module 4)
  app.use("/v1/badge",       freeRateLimiter, apiKeyMiddleware);
  app.use("/v1/score",       freeRateLimiter, apiKeyMiddleware);
  app.use("/v1/profile",     freeRateLimiter, apiKeyMiddleware);
  app.use("/v1/leaderboard", freeRateLimiter, apiKeyMiddleware);
  app.use("/v1/audit",       freeRateLimiter, apiKeyMiddleware);
  app.use("/v1/pool",        freeRateLimiter, apiKeyMiddleware);

  // Sponsored badge mint — Turnstile gate required (Module 5)
  app.use("/v1/mint", turnstileMiddleware);

  // Mount profile router (covers score, profile, leaderboard, audit, pool stats)
  app.use("/v1", profileRouter);

  // Applications list (admin use — no public key required in this version)
  app.get("/v1/applications", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT applicant, status, entity_type, name, paid_amount, applied_at, tx_digest
         FROM applications
         ORDER BY applied_at DESC
         LIMIT 100`
      );
      res.json({ applications: result.rows });
    } catch (err) {
      console.error("[API] /v1/applications error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Listen ───────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[API] Omen Backend listening on port ${PORT}`);
    console.log(`[API] Network  : ${NETWORK}`);
    console.log(`[API] Package  : ${OMEN_PACKAGE_ID.slice(0, 10)}...`);
    console.log(`[API] Endpoints:`);
    console.log(`[API]   GET /v1/score/:address`);
    console.log(`[API]   GET /v1/profile/:address`);
    console.log(`[API]   GET /v1/leaderboard`);
    console.log(`[API]   GET /v1/audit/:blobId`);
    console.log(`[API]   GET /v1/pool/:poolId/stats`);
    console.log(`[API]   GET /v1/applications`);
    console.log(`[API]   POST /v1/mint/*  (Turnstile-gated)`);
  });

  // ── Background services ───────────────────────────────────────────────────

  // Event indexer — WebSocket + polling fallback
  startEventListener(redis).catch((err) => {
    console.error("[Indexer] Fatal:", err);
    process.exit(1);
  });

  // Walrus blob expiry watchdog (Module 7)
  startBlobWatchdog(pool, redis).catch((err) => {
    console.error("[BlobWatchdog] Fatal:", err);
  });

  // Slash SLA monitor — 30-minute window (Module 8)
  startSlashMonitor(pool, process.env.SLACK_WEBHOOK_URL, process.env.PAGERDUTY_ROUTING_KEY).catch((err) => {
    console.error("[SlashMonitor] Fatal:", err);
  });
}

main().catch((err) => {
  console.error("[App] Fatal startup error:", err);
  process.exit(1);
});