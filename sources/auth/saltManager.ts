/**
 * ============================================================
 * OMEN BACKEND — src/auth/saltManager.ts
 * ============================================================
 * Module 1: zkLogin Salt Management
 *
 * Rules (non-negotiable):
 *   • Salts stored in AWS KMS only — never plaintext
 *   • Never logged anywhere in this file or callers
 *   • Never written to environment variables
 *   • DB stores KMS ciphertext only (base64)
 *   • Fallback: HashiCorp Vault stub (throws if Vault not configured)
 *   • The OmenBadge stores only the ZK proof commitment on-chain
 *
 * Salt format: 128-bit random → BigInt string (zkLogin requirement)
 * ============================================================
 */

import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
} from "@aws-sdk/client-kms";
import { randomBytes } from "crypto";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KMS_KEY_ID   = process.env.KMS_KEY_ID;
const AWS_REGION   = process.env.AWS_REGION ?? "us-east-1";
const VAULT_ADDR   = process.env.VAULT_ADDR;
const VAULT_TOKEN  = process.env.VAULT_TOKEN;
const VAULT_PATH   = process.env.VAULT_TRANSIT_PATH ?? "transit/omen-salt-key";

// ---------------------------------------------------------------------------
// KMS client — lazy singleton
// ---------------------------------------------------------------------------

let _kmsClient: KMSClient | null = null;

function getKMSClient(): KMSClient {
  if (!_kmsClient) {
    _kmsClient = new KMSClient({ region: AWS_REGION });
  }
  return _kmsClient;
}

// ---------------------------------------------------------------------------
// KMS encrypt / decrypt
// ---------------------------------------------------------------------------

async function kmsEncrypt(plaintext: string): Promise<string> {
  if (!KMS_KEY_ID) throw new Error("[SaltManager] KMS_KEY_ID not configured");

  const cmd = new EncryptCommand({
    KeyId:     KMS_KEY_ID,
    Plaintext: Buffer.from(plaintext, "utf-8"),
  });

  const result = await getKMSClient().send(cmd);
  if (!result.CiphertextBlob) {
    throw new Error("[SaltManager] KMS returned empty ciphertext");
  }

  return Buffer.from(result.CiphertextBlob).toString("base64");
}

async function kmsDecrypt(ciphertextBase64: string): Promise<string> {
  if (!KMS_KEY_ID) throw new Error("[SaltManager] KMS_KEY_ID not configured");

  const cmd = new DecryptCommand({
    CiphertextBlob: Buffer.from(ciphertextBase64, "base64"),
    KeyId: KMS_KEY_ID,
  });

  const result = await getKMSClient().send(cmd);
  if (!result.Plaintext) {
    throw new Error("[SaltManager] KMS returned empty plaintext");
  }

  return Buffer.from(result.Plaintext).toString("utf-8");
}

// ---------------------------------------------------------------------------
// HashiCorp Vault stub — transit secrets engine
// Replace stub implementations with real Vault SDK calls in production.
// ---------------------------------------------------------------------------

async function vaultEncrypt(plaintext: string): Promise<string> {
  if (!VAULT_ADDR || !VAULT_TOKEN) {
    throw new Error(
      "[SaltManager] CRITICAL: KMS unavailable and Vault not configured. " +
      "Set VAULT_ADDR + VAULT_TOKEN or fix KMS credentials. Salt operation aborted."
    );
  }

  // TODO: replace with actual Vault SDK / HTTP call
  // POST ${VAULT_ADDR}/v1/${VAULT_PATH}/encrypt
  // body: { plaintext: base64(plaintext) }
  // returns: { data: { ciphertext: "vault:v1:..." } }
  //
  // Example:
  //   const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_PATH}/encrypt`, {
  //     method: "POST",
  //     headers: { "X-Vault-Token": VAULT_TOKEN, "Content-Type": "application/json" },
  //     body: JSON.stringify({ plaintext: Buffer.from(plaintext).toString("base64") }),
  //   });
  //   const data = await res.json();
  //   return data.data.ciphertext;

  throw new Error(
    "[SaltManager] Vault stub — VAULT_ADDR is set but vault encrypt is not yet implemented. " +
    "Wire the Vault transit engine encrypt call here."
  );
}

async function vaultDecrypt(ciphertext: string): Promise<string> {
  if (!VAULT_ADDR || !VAULT_TOKEN) {
    throw new Error(
      "[SaltManager] CRITICAL: KMS unavailable and Vault not configured. " +
      "Set VAULT_ADDR + VAULT_TOKEN or fix KMS credentials. Salt operation aborted."
    );
  }

  // TODO: replace with actual Vault SDK / HTTP call
  // POST ${VAULT_ADDR}/v1/${VAULT_PATH}/decrypt
  // body: { ciphertext: "vault:v1:..." }
  // returns: { data: { plaintext: base64(plaintext) } }

  throw new Error(
    "[SaltManager] Vault stub — VAULT_ADDR is set but vault decrypt is not yet implemented. " +
    "Wire the Vault transit engine decrypt call here."
  );
}

// ---------------------------------------------------------------------------
// Public API — KMS primary, Vault fallback
// ---------------------------------------------------------------------------

/**
 * Encrypt a salt value. Returns KMS or Vault ciphertext.
 * NEVER passes the plaintext to logs.
 */
async function encryptSalt(plaintextSalt: string): Promise<string> {
  // KMS primary
  if (KMS_KEY_ID) {
    try {
      return await kmsEncrypt(plaintextSalt);
    } catch (err) {
      console.error("[SaltManager] KMS encrypt failed, falling back to Vault:", (err as Error).message);
    }
  }

  // Vault fallback
  return await vaultEncrypt(plaintextSalt);
}

/**
 * Decrypt a stored encrypted salt. Returns the raw salt BigInt string.
 * NEVER log the return value.
 */
async function decryptSalt(encryptedSalt: string): Promise<string> {
  // Detect vault ciphertext prefix
  if (encryptedSalt.startsWith("vault:")) {
    return await vaultDecrypt(encryptedSalt);
  }

  // KMS primary
  if (KMS_KEY_ID) {
    try {
      return await kmsDecrypt(encryptedSalt);
    } catch (err) {
      console.error("[SaltManager] KMS decrypt failed, falling back to Vault:", (err as Error).message);
    }
  }

  return await vaultDecrypt(encryptedSalt);
}

// ---------------------------------------------------------------------------
// getOrCreateSalt — primary export used by zkLogin flows
// ---------------------------------------------------------------------------

/**
 * Returns the decrypted zkLogin salt for a given OIDC user ID.
 *
 * @param userId  — OIDC `sub` claim. Treat as opaque; do not log.
 * @param pg      — Postgres pool
 * @returns       — Salt BigInt string for use in jwtToAddress()
 *
 * CALLER CONTRACT: never log or persist the return value.
 */
export async function getOrCreateSalt(userId: string, pg: Pool): Promise<string> {
  // Check for existing encrypted salt
  const existing = await pg.query(
    `SELECT encrypted_salt, kms_key_id FROM zklogin_salts WHERE user_id = $1`,
    [userId]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];

    // Detect if rotation is needed (KMS key changed)
    if (row.kms_key_id && KMS_KEY_ID && row.kms_key_id !== KMS_KEY_ID) {
      console.log("[SaltManager] KMS key rotation detected — re-encrypting salt");
      const plaintextSalt = await decryptSalt(row.encrypted_salt);
      const rotatedCiphertext = await encryptSalt(plaintextSalt);
      await pg.query(
        `UPDATE zklogin_salts
         SET encrypted_salt = $1, kms_key_id = $2, rotated_at = NOW()
         WHERE user_id = $3`,
        [rotatedCiphertext, KMS_KEY_ID, userId]
      );
      // plaintextSalt returned without logging — caller must handle securely
      return plaintextSalt;
    }

    return await decryptSalt(row.encrypted_salt);
  }

  // Generate new salt — 16 random bytes as BigInt string (zkLogin spec)
  const saltBytes  = randomBytes(16);
  const saltBigInt = BigInt("0x" + saltBytes.toString("hex")).toString();

  // Encrypt before any storage — plaintext never touches DB
  const encryptedSalt = await encryptSalt(saltBigInt);

  await pg.query(
    `INSERT INTO zklogin_salts (user_id, encrypted_salt, kms_key_id)
     VALUES ($1, $2, $3)`,
    [userId, encryptedSalt, KMS_KEY_ID ?? "vault"]
  );

  // Log provisioning without revealing the user ID or salt value
  console.log("[SaltManager] Salt provisioned for new user");

  return saltBigInt;
}

/**
 * Rotate the KMS key for a user's salt.
 * Decrypt with old key, re-encrypt with current KMS_KEY_ID.
 * Used during scheduled key rotation events.
 */
export async function rotateSalt(userId: string, pg: Pool): Promise<void> {
  const existing = await pg.query(
    `SELECT encrypted_salt FROM zklogin_salts WHERE user_id = $1`,
    [userId]
  );

  if (!existing.rows.length) {
    throw new Error("[SaltManager] Cannot rotate: no salt found for user");
  }

  const plaintextSalt    = await decryptSalt(existing.rows[0].encrypted_salt);
  const newEncryptedSalt = await encryptSalt(plaintextSalt);

  await pg.query(
    `UPDATE zklogin_salts
     SET encrypted_salt = $1, kms_key_id = $2, rotated_at = NOW()
     WHERE user_id = $3`,
    [newEncryptedSalt, KMS_KEY_ID ?? "vault", userId]
  );

  console.log("[SaltManager] Salt rotated (user id redacted)");
}
