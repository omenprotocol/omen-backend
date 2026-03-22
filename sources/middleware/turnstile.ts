/**
 * ============================================================
 * OMEN BACKEND — src/middleware/turnstile.ts
 * ============================================================
 * Module 5: Cloudflare Turnstile Gate
 *
 * All sponsored badge mint requests must pass Turnstile verification
 * before the sponsored transaction is submitted to Sui.
 *
 * Two independent layers:
 *   1. This middleware — Web2 identity gate (bot/sybil filter)
 *   2. Move contract  — epoch-based rate limits on-chain
 *      (max_sponsored_mints_per_epoch = 1000 globally,
 *       max_mints_per_address_per_epoch = 1)
 *
 * Both layers enforce independently. Passing Turnstile does NOT
 * override the contract limits.
 * ============================================================
 */

import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TURNSTILE_SECRET_KEY  = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
const TURNSTILE_VERIFY_URL  = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_HEADER      = "cf-turnstile-response"; // client sends token here
const TURNSTILE_BODY_FIELD  = "turnstileToken";         // or in JSON body

// ---------------------------------------------------------------------------
// Turnstile verification
// ---------------------------------------------------------------------------

interface TurnstileVerifyResponse {
  success:      boolean;
  challenge_ts: string;
  hostname:     string;
  "error-codes"?: string[];
  action?:       string;
  cdata?:        string;
}

async function verifyTurnstileToken(
  token:    string,
  clientIp: string
): Promise<{ success: boolean; errorCodes?: string[] }> {
  if (!TURNSTILE_SECRET_KEY) {
    throw new Error(
      "[Turnstile] CLOUDFLARE_TURNSTILE_SECRET_KEY not set. " +
      "Cannot verify Turnstile token."
    );
  }

  const formData = new URLSearchParams();
  formData.append("secret",   TURNSTILE_SECRET_KEY);
  formData.append("response", token);
  formData.append("remoteip", clientIp);

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    formData.toString(),
  });

  if (!response.ok) {
    throw new Error(
      `[Turnstile] Cloudflare API returned HTTP ${response.status}`
    );
  }

  const data = (await response.json()) as TurnstileVerifyResponse;

  return {
    success:    data.success,
    errorCodes: data["error-codes"],
  };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * turnstileMiddleware
 *
 * Attach to any route that triggers a sponsored Sui transaction.
 * Rejects requests without a valid Turnstile token before any
 * on-chain work is attempted.
 *
 * Expects token in one of:
 *   - Header:       cf-turnstile-response: <token>
 *   - JSON body:    { turnstileToken: "<token>", ... }
 */
export async function turnstileMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Extract token — header takes precedence over body
  const token: string | undefined =
    (req.headers[TURNSTILE_HEADER] as string | undefined) ??
    (req.body?.[TURNSTILE_BODY_FIELD] as string | undefined);

  if (!token) {
    res.status(403).json({
      error:   true,
      code:    "TURNSTILE_TOKEN_MISSING",
      message: "Cloudflare Turnstile token is required for sponsored mint requests.",
    });
    return;
  }

  // Real IP — respect CF-Connecting-IP if behind Cloudflare
  const clientIp: string =
    (req.headers["cf-connecting-ip"] as string) ??
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "0.0.0.0";

  try {
    const { success, errorCodes } = await verifyTurnstileToken(token, clientIp);

    if (!success) {
      console.warn(
        `[Turnstile] Verification failed for IP ${clientIp}: ${JSON.stringify(errorCodes)}`
      );
      res.status(403).json({
        error:      true,
        code:       "TURNSTILE_VERIFICATION_FAILED",
        message:    "Turnstile challenge failed. Please retry.",
        errorCodes,
      });
      return;
    }

    console.log(`[Turnstile] Verified — IP: ${clientIp}`);
    next();

  } catch (err) {
    console.error("[Turnstile] Verification error:", err);
    res.status(500).json({
      error:   true,
      code:    "TURNSTILE_SERVICE_ERROR",
      message: "Could not verify Turnstile token. Please try again.",
    });
  }
}