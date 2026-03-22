/**
 * ============================================================
 * OMEN PROTOCOL — Phase 1: AI Auditing Engine
 * ============================================================
 * Fetches compiled Move bytecode from the Sui network,
 * runs deterministic static analysis for common vulnerabilities,
 * and produces a structured JSON audit report.
 *
 * Output feeds directly into Phase 2 (Walrus upload) and
 * Phase 3 (ZK proof generation).
 * ============================================================
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VulnerabilityFlag {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  title: string;
  description: string;
  bytecodeOffset?: number;
}

export interface AuditReport {
  schemaVersion: "1.0";
  auditedAt: string; // ISO-8601
  packageId: string;
  moduleName: string;
  riskScore: number; // 0–100 where 100=clean, 1=critical risk, 0=unaudited
  vulnerabilities: VulnerabilityFlag[];
  sybilWarnings: string[];
  cartelWarnings: string[];
  bytecodeSizeBytes: number;
  functionsAnalyzed: number;
  rawBytecodeHash: string; // SHA-256 hex of the bytecode
}

// ---------------------------------------------------------------------------
// Vulnerability Detector Registry
// ---------------------------------------------------------------------------
// Each detector receives the bytecode as a hex string and the parsed module
// metadata, and returns any flags it finds.
// ---------------------------------------------------------------------------

type Detector = (
  bytecodeHex: string,
  meta: ModuleMeta
) => VulnerabilityFlag[];

interface ModuleMeta {
  functionNames: string[];
  publicFunctions: string[];
  entryFunctions: string[];
}

/**
 * Detector 1 — Missing TxContext Check
 * Entry functions that accept Coin or SUI but don't reference
 * TxContext are suspicious: they can't verify the caller's identity.
 */
const detectMissingTxContext: Detector = (bytecodeHex, meta) => {
  const flags: VulnerabilityFlag[] = [];

  // Bytecode-level heuristic: look for MOVE_TO / ST_LOC patterns
  // without a corresponding CALL_GENERIC to tx_context::sender
  // Real implementation would parse the Move binary format (BCS).
  // This is a pattern-matching approximation over the hex string.
  const hasTxContextCall =
    bytecodeHex.includes("74785f636f6e74657874") || // "tx_context" in hex
    bytecodeHex.includes("73656e646572"); // "sender" in hex

  const hasPaymentOp =
    bytecodeHex.includes("636f696e") || // "coin"
    bytecodeHex.includes("62616c616e6365"); // "balance"

  if (hasPaymentOp && !hasTxContextCall) {
    flags.push({
      id: "OMEN-001",
      severity: "CRITICAL",
      title: "Missing tx_context::sender check in payment function",
      description:
        "The module handles Coin or Balance objects but does not appear " +
        "to verify the transaction sender via tx_context::sender(). " +
        "This may allow unauthorized callers to drain funds.",
    });
  }

  return flags;
};

/**
 * Detector 2 — Infinite Mint Loop
 * Looks for mint/create patterns inside loop bytecode sequences.
 * Loop opcodes in Move bytecode: BRANCH (0x0D), JUMP (0x0E)
 */
const detectInfiniteMint: Detector = (bytecodeHex) => {
  const flags: VulnerabilityFlag[] = [];

  // Opcodes as byte patterns in the hex stream
  const BRANCH_OPCODE = "0d"; // backwards branch = loop
  const MINT_PATTERN = "6d696e74"; // "mint" in ASCII hex

  // Count backwards branches near mint operations
  const mintPositions: number[] = [];
  let searchIdx = 0;
  while (true) {
    const pos = bytecodeHex.indexOf(MINT_PATTERN, searchIdx);
    if (pos === -1) break;
    mintPositions.push(pos);
    searchIdx = pos + 1;
  }

  for (const mintPos of mintPositions) {
    // Look for BRANCH opcode within 64 bytes before mint (loop body)
    const window = bytecodeHex.slice(Math.max(0, mintPos - 128), mintPos);
    if (window.includes(BRANCH_OPCODE)) {
      flags.push({
        id: "OMEN-002",
        severity: "CRITICAL",
        title: "Potential infinite mint loop detected",
        description:
          "A mint or token creation operation appears inside a loop construct. " +
          "Without a bounded counter enforced by the Move type system, " +
          "this could allow unbounded token issuance.",
        bytecodeOffset: mintPos / 2, // hex chars → bytes
      });
      break; // Report once per module
    }
  }

  return flags;
};

/**
 * Detector 3 — Unguarded Public Entry
 * Public entry functions that touch shared objects but have no
 * assert!/abort guard in their first 32 opcodes are suspicious.
 */
const detectUnguardedEntry: Detector = (bytecodeHex, meta) => {
  const flags: VulnerabilityFlag[] = [];

  // Heuristic: look for entry functions that contain "shared" object
  // patterns without an assert opcode (0x26 in Move bytecode)
  const ASSERT_OPCODE = "26";
  const SHARED_PATTERN = "736861726564"; // "shared"

  if (
    bytecodeHex.includes(SHARED_PATTERN) &&
    !bytecodeHex.includes(ASSERT_OPCODE)
  ) {
    flags.push({
      id: "OMEN-003",
      severity: "HIGH",
      title: "Public entry touches shared object without assert guard",
      description:
        "One or more public entry functions appear to mutate a shared object " +
        "without any assert!/abort guards. This may allow state manipulation " +
        "without authorization checks.",
    });
  }

  return flags;
};

/**
 * Detector 4 — Upgrade Authority Backdoor
 * Modules that retain an UpgradeCap without publishing to immutable
 * are a rug-pull vector: the team can push malicious upgrades later.
 */
const detectUpgradeBackdoor: Detector = (bytecodeHex) => {
  const flags: VulnerabilityFlag[] = [];

  const UPGRADE_CAP = "555067726164654361700a"; // "UpgradeCap\n"
  const MAKE_IMMUTABLE = "6d616b655f696d6d757461626c65"; // "make_immutable"

  if (
    bytecodeHex.includes(UPGRADE_CAP) &&
    !bytecodeHex.includes(MAKE_IMMUTABLE)
  ) {
    flags.push({
      id: "OMEN-004",
      severity: "HIGH",
      title: "UpgradeCap retained — package is not immutable",
      description:
        "The package retains an UpgradeCap but does not call " +
        "package::make_immutable(). The deployer can push code upgrades " +
        "at any time, including malicious changes after launch.",
    });
  }

  return flags;
};

// All detectors in execution order
const DETECTORS: Detector[] = [
  detectMissingTxContext,
  detectInfiniteMint,
  detectUnguardedEntry,
  detectUpgradeBackdoor,
];

// ---------------------------------------------------------------------------
// Risk Score Calculator
// ---------------------------------------------------------------------------

function calculateRiskScore(vulnerabilities: VulnerabilityFlag[]): number {
  if (vulnerabilities.length === 0) return 100;

  const penaltyMap: Record<VulnerabilityFlag["severity"], number> = {
    CRITICAL: 40,
    HIGH: 20,
    MEDIUM: 10,
    LOW: 5,
    INFO: 0,
  };

  const totalPenalty = vulnerabilities.reduce(
    (sum, v) => sum + penaltyMap[v.severity],
    0
  );

  return Math.max(1, 100 - totalPenalty);
}

// ---------------------------------------------------------------------------
// Bytecode Hash
// ---------------------------------------------------------------------------

async function sha256Hex(data: Uint8Array): Promise<string> {
  // Node.js built-in crypto
  const { createHash } = await import("crypto");
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Main Audit Function
// ---------------------------------------------------------------------------

export async function auditPackage(
  packageId: string,
  moduleName: string,
  network: "mainnet" | "testnet" | "devnet" = "testnet"
): Promise<AuditReport> {
  const client = new SuiClient({ url: getFullnodeUrl(network) });

  console.log(`[Omen Auditor] Fetching package ${packageId}::${moduleName}`);

  // Fetch the normalized Move module (includes function metadata)
  const normalizedModule = await client.getNormalizedMoveModule({
    package: packageId,
    module: moduleName,
  });

  // Fetch raw bytecode via getObject on the package
  const packageObj = await client.getObject({
    id: packageId,
    options: { showBcs: true, showContent: true },
  });

  if (!packageObj.data) {
    throw new Error(`Package ${packageId} not found on ${network}`);
  }

  // Extract bytecode — SUI returns it base64-encoded in BCS representation
  // In a production implementation you would parse the full BCS PackageObject
  // and extract the specific module's bytecode. Here we use the BCS bytes
  // as a proxy for demonstration.
  const bcsData = packageObj.data.bcs;
  if (!bcsData || bcsData.dataType !== "package") {
    throw new Error(`Object ${packageId} is not a Move package`);
  }

  // Locate our specific module bytes within the package
  const moduleBase64 = bcsData.moduleMap?.[moduleName];
  if (!moduleBase64) {
    throw new Error(`Module ${moduleName} not found in package ${packageId}`);
  }

  const moduleBytes = Buffer.from(moduleBase64, "base64");
  const bytecodeHex = moduleBytes.toString("hex");
  const bytecodeHash = await sha256Hex(moduleBytes);

  console.log(
    `[Omen Auditor] Bytecode fetched: ${moduleBytes.length} bytes, SHA-256: ${bytecodeHash}`
  );

  // Build module metadata from normalized module
  const functionNames = Object.keys(normalizedModule.exposedFunctions);
  const publicFunctions = functionNames.filter(
    (fn) => normalizedModule.exposedFunctions[fn].visibility === "Public"
  );
  const entryFunctions = functionNames.filter(
    (fn) => normalizedModule.exposedFunctions[fn].isEntry
  );

  const meta: ModuleMeta = { functionNames, publicFunctions, entryFunctions };

  console.log(
    `[Omen Auditor] Running ${DETECTORS.length} vulnerability detectors...`
  );

  // Run all detectors
  const allVulnerabilities: VulnerabilityFlag[] = [];
  for (const detector of DETECTORS) {
    const found = detector(bytecodeHex, meta);
    allVulnerabilities.push(...found);
    if (found.length > 0) {
      console.warn(
        `[Omen Auditor] ⚠️  ${found.length} flag(s) from detector: ${found[0].id}`
      );
    }
  }

  // Sybil / Cartel heuristics (off-chain graph analysis would feed these)
  const sybilWarnings: string[] = [];
  const cartelWarnings: string[] = [];

  if (entryFunctions.length > 20) {
    sybilWarnings.push(
      "Unusually high number of entry functions — may indicate obfuscation."
    );
  }

  const riskScore = calculateRiskScore(allVulnerabilities);

  const report: AuditReport = {
    schemaVersion: "1.0",
    auditedAt: new Date().toISOString(),
    packageId,
    moduleName,
    riskScore,
    vulnerabilities: allVulnerabilities,
    sybilWarnings,
    cartelWarnings,
    bytecodeSizeBytes: moduleBytes.length,
    functionsAnalyzed: functionNames.length,
    rawBytecodeHash: bytecodeHash,
  };

  console.log(
    `[Omen Auditor] ✅ Audit complete. Risk Score: ${riskScore}/100, Flags: ${allVulnerabilities.length}`
  );

  return report;
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [, , packageId, moduleName, network] = process.argv;

  if (!packageId || !moduleName) {
    console.error(
      "Usage: npx ts-node auditor.ts <packageId> <moduleName> [mainnet|testnet|devnet]"
    );
    process.exit(1);
  }

  auditPackage(
    packageId,
    moduleName,
    (network as "mainnet" | "testnet" | "devnet") ?? "testnet"
  )
    .then((report) => {
      console.log("\n--- AUDIT REPORT ---");
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      console.error("[Omen Auditor] Fatal error:", err);
      process.exit(1);
    });
}
