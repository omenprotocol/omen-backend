/**
 * ============================================================
 * OMEN PROTOCOL — Phase 5: Model Context Protocol (MCP) Server
 * ============================================================
 * Exposes Omen's on-chain reputation data as MCP tools that any
 * AI agent or LLM client can consume natively.
 *
 * This is the machine-to-machine monetization layer. External AI
 * agents (trading bots, DeFi protocols, wallet UIs) can query
 * trust scores and audit reports in a single standardized call.
 *
 * Tools exposed:
 *   get_trust_score(sui_address)   — reads OmenBadge from Sui RPC
 *   fetch_walrus_audit(blob_id)    — fetches JSON report from Walrus
 *
 * Transport: StdioServerTransport (pipe-based, works with Claude Desktop,
 * Cursor, and any MCP-compatible client out of the box)
 *
 * Usage:
 *   npx ts-node mcp-server.ts
 * Then configure your MCP client to spawn this process.
 * ============================================================
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { fetchAuditReport } from "../walrus/fetcher.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "mainnet"
  | "testnet"
  | "devnet";

const PACKAGE_ID = process.env.OMEN_PACKAGE_ID!;

const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

// ---------------------------------------------------------------------------
// Helpers: Read from Sui RPC
// ---------------------------------------------------------------------------

/**
 * Reads a verified creator's badge ID from the OmenRegistry shared object,
 * then reads the badge's dynamic fields to return a structured trust profile.
 */
async function readTrustProfile(suiAddress: string): Promise<{
  isVerified: boolean;
  badgeId?: string;
  creatorName?: string;
  trustScore?: number;
  isActive?: boolean;
  verificationTier?: number;
  reviewCount?: number;
  riskScore?: number;
  walrusBlobId?: string;
  premiumExpiry?: number;
  issueDate?: number;
}> {
  // Look up the badge by querying the creator's owned objects
  // and finding an OmenBadge type
  const ownedObjects = await client.getOwnedObjects({
    owner: suiAddress,
    filter: {
      StructType: `${PACKAGE_ID}::omen_badge::OmenBadge`,
    },
    options: { showContent: true, showType: true },
  });

  if (!ownedObjects.data.length) {
    return { isVerified: false };
  }

  const badgeObj = ownedObjects.data[0];
  const badgeId = badgeObj.data?.objectId;
  const content = badgeObj.data?.content;

  if (!content || content.dataType !== "moveObject") {
    return { isVerified: false };
  }

  // Top-level badge fields
  const fields = content.fields as Record<string, unknown>;
  const creatorName = fields.creator_name as string;
  const issueDate = Number(fields.issue_date);

  // Fetch dynamic fields (trust score, active status, etc.)
  const dynamicFields = await client.getDynamicFields({ parentId: badgeId! });

  const dfMap: Record<string, unknown> = {};
  for (const df of dynamicFields.data) {
    const dfObj = await client.getDynamicFieldObject({
      parentId: badgeId!,
      name: df.name,
    });
    const dfContent = dfObj.data?.content;
    if (dfContent && dfContent.dataType === "moveObject") {
      const dfFields = dfContent.fields as Record<string, unknown>;
      // Dynamic field key type name → value
      const keyType = df.name.type;
      dfMap[keyType] = dfFields.value;
    }
  }

  const keyPrefix = `${PACKAGE_ID}::omen_badge`;

  return {
    isVerified: true,
    badgeId,
    creatorName,
    issueDate,
    trustScore: Number(dfMap[`${keyPrefix}::TrustScoreKey`] ?? 0),
    isActive: Boolean(dfMap[`${keyPrefix}::IsActiveKey`] ?? false),
    verificationTier: Number(dfMap[`${keyPrefix}::VerificationTierKey`] ?? 0),
    reviewCount: Number(dfMap[`${keyPrefix}::ReviewCountKey`] ?? 0),
    riskScore: Number(dfMap[`${keyPrefix}::RiskScoreKey`] ?? 0),
    walrusBlobId: (dfMap[`${keyPrefix}::WalrusBlobIdKey`] as string) ?? "",
    premiumExpiry: Number(dfMap[`${keyPrefix}::PremiumExpiryKey`] ?? 0),
  };
}

// ---------------------------------------------------------------------------
// MCP Server Setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "omen-protocol",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool 1: get_trust_score
// ---------------------------------------------------------------------------

server.tool(
  "get_trust_score",
  "Query the Omen Protocol trust profile for a Sui wallet address. " +
    "Returns verification status, trust score (0-100), risk score from AI audit, " +
    "tier, and review count. Use this before interacting with any Sui founder or project.",
  {
    sui_address: z
      .string()
      .describe(
        "The Sui wallet address (0x...) of the founder or creator to look up."
      ),
  },
  async ({ sui_address }) => {
    try {
      console.error(`[MCP] get_trust_score called for ${sui_address}`);

      const profile = await readTrustProfile(sui_address);

      if (!profile.isVerified) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sui_address,
                isVerified: false,
                message:
                  "This address has no Omen Protocol badge. " +
                  "Treat interactions with extreme caution — no on-chain reputation exists.",
              }),
            },
          ],
        };
      }

      const tierLabel = ["Individual", "Team", "Enterprise"][
        profile.verificationTier ?? 0
      ];
      const riskLabel =
        profile.riskScore === 0
          ? "Unaudited"
          : profile.riskScore! >= 80
          ? "Low Risk"
          : profile.riskScore! >= 50
          ? "Medium Risk"
          : "High Risk";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sui_address,
                isVerified: true,
                badgeId: profile.badgeId,
                creatorName: profile.creatorName,
                trustScore: profile.trustScore,
                isActive: profile.isActive,
                verificationTier: tierLabel,
                reviewCount: profile.reviewCount,
                aiRiskScore: profile.riskScore,
                aiRiskLabel: riskLabel,
                hasAuditReport: !!profile.walrusBlobId,
                walrusBlobId: profile.walrusBlobId,
                premiumActive:
                  (profile.premiumExpiry ?? 0) > Date.now(),
                issuedAt: profile.issueDate
                  ? new Date(profile.issueDate).toISOString()
                  : null,
                interpretation:
                  `${profile.creatorName} is a verified ${tierLabel} on Omen Protocol ` +
                  `with a trust score of ${profile.trustScore}/100. ` +
                  `AI risk assessment: ${riskLabel} (${profile.riskScore}/100). ` +
                  (profile.walrusBlobId
                    ? `Full audit report available — use fetch_walrus_audit("${profile.walrusBlobId}") to read it.`
                    : "No AI audit report on file yet."),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: true,
              message: `Failed to query trust profile: ${(error as Error).message}`,
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 2: fetch_walrus_audit
// ---------------------------------------------------------------------------

server.tool(
  "fetch_walrus_audit",
  "Fetch the full JSON audit report for a Move smart contract from Walrus " +
    "decentralized storage using the Blob ID stored on the founder's Omen badge. " +
    "Returns the complete vulnerability analysis, risk score breakdown, " +
    "and bytecode inspection results produced by the Omen AI engine.",
  {
    blob_id: z
      .string()
      .describe(
        "The Walrus Blob ID (returned by get_trust_score as walrusBlobId). " +
          "Looks like a base58-encoded string."
      ),
  },
  async ({ blob_id }) => {
    try {
      console.error(`[MCP] fetch_walrus_audit called for blob ${blob_id}`);

      const report = await fetchAuditReport(blob_id);

      // Format vulnerabilities for human/AI readability
      const vulnSummary = report.vulnerabilities.map((v) => ({
        id: v.id,
        severity: v.severity,
        title: v.title,
        description: v.description,
      }));

      const riskLabel =
        report.riskScore === 0
          ? "Unaudited"
          : report.riskScore >= 80
          ? "Low Risk ✅"
          : report.riskScore >= 50
          ? "Medium Risk ⚠️"
          : "High Risk 🚨";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                blobId: blob_id,
                packageId: report.packageId,
                moduleName: report.moduleName,
                auditedAt: report.auditedAt,
                riskScore: report.riskScore,
                riskLabel,
                vulnerabilitiesFound: report.vulnerabilities.length,
                vulnerabilities: vulnSummary,
                sybilWarnings: report.sybilWarnings,
                cartelWarnings: report.cartelWarnings,
                bytecodeSizeBytes: report.bytecodeSizeBytes,
                functionsAnalyzed: report.functionsAnalyzed,
                bytecodeIntegrityHash: report.rawBytecodeHash,
                interpretation:
                  report.vulnerabilities.length === 0
                    ? `This smart contract passed all ${report.functionsAnalyzed} function checks with no flags. Risk: ${riskLabel}.`
                    : `This smart contract has ${report.vulnerabilities.length} vulnerability flag(s). ` +
                      `Most severe: ${report.vulnerabilities[0]?.severity} — "${report.vulnerabilities[0]?.title}". ` +
                      `Risk: ${riskLabel}.`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: true,
              message: `Failed to fetch audit report: ${(error as Error).message}`,
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Omen MCP] Server running on stdio. Waiting for requests...");
}

main().catch((err) => {
  console.error("[Omen MCP] Fatal error:", err);
  process.exit(1);
});
