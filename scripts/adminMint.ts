/**
 * ============================================================
 * OMEN BACKEND — scripts/adminMint.ts
 * ============================================================
 * Admin script for end-to-end badge minting.
 *
 * Two commands:
 *   npx tsx scripts/adminMint.ts submit <address> <name> <entityType>
 *   npx tsx scripts/adminMint.ts approve <address> <initialScore>
 *
 * Entity types: 0 = Individual, 1 = Team, 2 = Enterprise
 *
 * Requires in .env:
 *   ADMIN_PRIVATE_KEY — suiprivkey1... format (terminal only, never commit)
 *   PACKAGE_ID
 *   OMEN_REGISTRY_ID
 *   ADMIN_CAP_ID
 *
 * Usage examples:
 *   npx tsx scripts/adminMint.ts submit 0xdd2e...  "Omen Labs" 1
 *   npx tsx scripts/adminMint.ts approve 0xdd2e... 85
 * ============================================================
 */

import dotenv from "dotenv";
dotenv.config();

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NETWORK = (process.env.SUI_NETWORK ?? "testnet") as "mainnet" | "testnet" | "devnet";

// Read at call time — dotenv is guaranteed to have run before any function executes
function cfg(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`${key} not set in .env`);
  return val;
}

const USDC_PACKAGE =  process.env.USDC_PACKAGE ?? "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29";
const USDC_COIN_TYPE = `${USDC_PACKAGE}::usdc::USDC`;

const GAS_BUDGET = 50_000_000;

// ---------------------------------------------------------------------------
// Client + Keypair
// ---------------------------------------------------------------------------

const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

function getKeypair(): Ed25519Keypair {
  const privateKey = cfg("ADMIN_PRIVATE_KEY");
  if (privateKey.startsWith("suiprivkey")) {
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  return Ed25519Keypair.fromSecretKey(Buffer.from(hex, "hex"));
}

// ---------------------------------------------------------------------------
// Command: submit
// Submit a badge application on behalf of an address.
// In production the applicant submits their own — this is for testing only.
// ---------------------------------------------------------------------------

async function submitApplication(
  applicantAddress: string,
  name:             string,
  entityType:       number  // 0=Individual, 1=Team, 2=Enterprise
): Promise<void> {
  console.log(`\n[AdminMint] Submitting application for ${applicantAddress}`);
  console.log(`[AdminMint] Name: ${name} | Entity type: ${entityType}`);

  const keypair = getKeypair();
  const sender  = keypair.getPublicKey().toSuiAddress();
  console.log(`[AdminMint] Admin wallet: ${sender}`);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(GAS_BUDGET);

  // Fees: 0 SUI (Individual), 5 SUI (Team), 10 SUI (Protocol/DAO)
  const FEE_MAP: Record<number, number> = { 0: 0, 1: 5_000_000_000, 2: 10_000_000_000 };
  const fee = FEE_MAP[entityType] ?? 0;

  let paymentArg;
  if (fee === 0) {
    // Free tier — split 1 MIST as a zero-value coin placeholder
    [paymentArg] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  } else {
    [paymentArg] = tx.splitCoins(tx.gas, [tx.pure.u64(fee)]);
  }

  tx.moveCall({
    target: `${cfg("PACKAGE_ID")}::omen_registry::submit_application`,
    arguments: [
      tx.object(process.env.OMEN_REGISTRY_ID ?? process.env.REGISTRY_ID ?? (() => { throw new Error("OMEN_REGISTRY_ID not set"); })()),
      tx.object("0x6"),                    // clock
      tx.pure.u8(entityType),              // entity_type
      tx.pure.string(name),                // name
      tx.pure.string("https://omenlabs.com"), // initial_social
      paymentArg,                          // payment: Coin<SUI>
    ],
  });

  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer:      keypair,
      options:     { showEffects: true, showEvents: true },
    });

    if (result.effects?.status?.status !== "success") {
      throw new Error(`Transaction failed: ${JSON.stringify(result.effects?.status)}`);
    }

    console.log(`[AdminMint] ✅ Application submitted`);
    console.log(`[AdminMint]    Digest: ${result.digest}`);

    // Print any events
    for (const event of result.events ?? []) {
      if (event.type.includes("ApplicationSubmitted")) {
        console.log(`[AdminMint]    Event: ApplicationSubmitted`);
        console.log(`[AdminMint]    Data:`, JSON.stringify(event.parsedJson, null, 2));
      }
    }

    console.log(`\n[AdminMint] Next step — approve this application:`);
    console.log(`[AdminMint]   npx tsx scripts/adminMint.ts approve ${applicantAddress} 75`);

  } catch (err) {
    console.error(`[AdminMint] ❌ Submit failed:`, err);
    console.log(`\n[AdminMint] If the error is about coin type, the contract may require USDC.`);
    console.log(`[AdminMint] Check the contract's submit_application signature.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command: approve
// Admin approves a pending application and mints the OmenBadge.
// ---------------------------------------------------------------------------

async function approveApplication(
  applicantAddress: string,
  initialScore:     number
): Promise<void> {
  console.log(`\n[AdminMint] Approving application for ${applicantAddress}`);
  console.log(`[AdminMint] Initial trust score: ${initialScore}`);

  const keypair = getKeypair();
  const sender  = keypair.getPublicKey().toSuiAddress();
  console.log(`[AdminMint] Admin wallet: ${sender}`);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(GAS_BUDGET);

  // On-chain signature (5 args + ctx injected):
  // approve_application(&AdminCap, &mut OmenRegistry, &Clock, address, u64, &mut TxContext)
  tx.moveCall({
    target: `${cfg("PACKAGE_ID")}::omen_registry::approve_application`,
    arguments: [
      tx.object(cfg("ADMIN_CAP_ID")),      // _admin: &AdminCap
      tx.object(process.env.OMEN_REGISTRY_ID ?? process.env.REGISTRY_ID ?? (() => { throw new Error("OMEN_REGISTRY_ID not set"); })()),
      tx.object("0x6"),                    // clock: &Clock
      tx.pure.address(applicantAddress),   // applicant: address
      tx.pure.u64(initialScore),           // initial_score: u64
    ],
  });

  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer:      keypair,
      options:     { showEffects: true, showEvents: true },
    });

    if (result.effects?.status?.status !== "success") {
      throw new Error(`Transaction failed: ${JSON.stringify(result.effects?.status)}`);
    }

    console.log(`[AdminMint] ✅ Application approved — badge minted`);
    console.log(`[AdminMint]    Digest: ${result.digest}`);

    // Print events
    for (const event of result.events ?? []) {
      const type = event.type;
      if (type.includes("ApplicationApproved") || type.includes("CreatorVerified")) {
        console.log(`[AdminMint]    Event: ${type.split("::").pop()}`);
        console.log(`[AdminMint]    Data:`, JSON.stringify(event.parsedJson, null, 2));
      }
    }

    console.log(`\n[AdminMint] Verify on backend:`);
    console.log(`[AdminMint]   curl http://localhost:3000/v1/profile/${applicantAddress}`);

  } catch (err) {
    console.error(`[AdminMint] ❌ Approve failed:`, err);

    // Common failure reasons
    const errMsg = String(err);
    if (errMsg.includes("AdminCap")) {
      console.log(`\n[AdminMint] AdminCap error — verify ADMIN_CAP_ID in .env matches the cap owned by your wallet.`);
      console.log(`[AdminMint]   sui client objects --json | grep -A2 AdminCap`);
    }
    if (errMsg.includes("not found") || errMsg.includes("pending")) {
      console.log(`\n[AdminMint] Application not found — run submit first:`);
      console.log(`[AdminMint]   npx tsx scripts/adminMint.ts submit ${applicantAddress} "Name" 0`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command: full
// Submit + approve in one shot (for testing only)
// ---------------------------------------------------------------------------

async function fullMint(
  applicantAddress: string,
  name:             string,
  entityType:       number,
  initialScore:     number
): Promise<void> {
  await submitApplication(applicantAddress, name, entityType);
  // Wait for indexer to pick up the submit event
  console.log(`\n[AdminMint] Waiting 3s for indexer...`);
  await new Promise(r => setTimeout(r, 3000));
  await approveApplication(applicantAddress, initialScore);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...args] = process.argv;

switch (command) {
  case "submit":
    if (args.length < 3) {
      console.error("Usage: npx tsx scripts/adminMint.ts submit <address> <name> <entityType>");
      console.error("Entity types: 0=Individual 1=Team 2=Enterprise");
      process.exit(1);
    }
    submitApplication(args[0]!, args[1]!, Number(args[2]!));
    break;

  case "approve":
    if (args.length < 2) {
      console.error("Usage: npx tsx scripts/adminMint.ts approve <address> <initialScore>");
      process.exit(1);
    }
    approveApplication(args[0]!, Number(args[1]!));
    break;

  case "full":
    if (args.length < 4) {
      console.error("Usage: npx tsx scripts/adminMint.ts full <address> <name> <entityType> <initialScore>");
      process.exit(1);
    }
    fullMint(args[0]!, args[1]!, Number(args[2]!), Number(args[3]!));
    break;

  default:
    console.log(`
OMEN Admin Mint Script
======================
Commands:
  submit  <address> <name> <entityType>              — submit application
  approve <address> <initialScore>                   — approve + mint badge
  full    <address> <name> <entityType> <initialScore> — submit + approve in one shot

Entity types: 0=Individual  1=Team  2=Enterprise

Examples:
  npx tsx scripts/adminMint.ts submit  0xdd2e... "Omen Labs" 1
  npx tsx scripts/adminMint.ts approve 0xdd2e... 85
  npx tsx scripts/adminMint.ts full    0xdd2e... "Omen Labs" 1 85
    `);
    process.exit(0);
}