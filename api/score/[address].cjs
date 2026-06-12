// FILE PATH IN REPO: api/score/[address].js
// Rename this file to [address].js when adding to GitHub
// Reads directly from Sui testnet RPC — no backend, no cache
// Chain is the single source of truth

const SUI_RPC = 'https://fullnode.testnet.sui.io';

const PACKAGE_ID        = '0x7575a9de7b2b996c314d82ee4e1fe0eb0eec9725c9d96bb324917f8494eae415';
const REGISTRY_ID       = '0x2dda3a2a639d9747599cffecba9ff9e729c3e16fd886497ac049332ecd4e4d95';
const CREATORS_TABLE_ID = '0x89b79b536e270bd320cc9c32216edbfdd6be52006f85d72a80eac739f3ff225a';

// Trust score — deterministic, computed from on-chain fields only
// base(60) + ageBonus(max 25, 1pt per week) + activityBonus(max 15, 3pts per update)
function computeTrustScore(issueDate, updateCount) {
  const ageDays = (Date.now() - Number(issueDate)) / (1000 * 60 * 60 * 24);
  const base = 60;
  const ageBonus = Math.min(25, Math.floor(ageDays / 7));
  const activityBonus = Math.min(15, Number(updateCount) * 3);
  return { total: base + ageBonus + activityBonus, base, ageBonus, activityBonus, ageDays: Math.floor(ageDays) };
}

async function rpcCall(method, params) {
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP error: ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { address } = req.query;

  if (!address || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    return res.status(400).json({
      error: 'Invalid address format',
      hint: 'Sui addresses start with 0x followed by up to 64 hex characters'
    });
  }

  try {
    // Step 1 — look up address in verified_creators table
    // suix_getDynamicFieldObject returns the wrapper object
    // wrapper.data.content.fields.value = the badge object ID
    let badgeObjectId = null;

    try {
      const wrapper = await rpcCall('suix_getDynamicFieldObject', [
        CREATORS_TABLE_ID,
        { type: 'address', value: address }
      ]);
      badgeObjectId = wrapper?.data?.content?.fields?.value ?? null;
    } catch {
      // Address not in registry — unverified, not an error
    }

    // Not verified
    if (!badgeObjectId) {
      return res.status(200).json({
        address,
        isVerified: false,
        isActive: false,
        trustScore: 0,
        riskScore: 100,
        badgeStatus: 'none',
        badge: null,
        source: 'chain',
        queriedAt: new Date().toISOString()
      });
    }

    // Step 2 — fetch the badge object using the ID from the wrapper
    const badgeResult = await rpcCall('sui_getObject', [
      badgeObjectId,
      { showContent: true, showType: true }
    ]);

    const fields = badgeResult?.data?.content?.fields;

    if (!fields) {
      return res.status(200).json({
        address,
        isVerified: true,
        isActive: false,
        trustScore: 0,
        riskScore: 50,
        badgeStatus: 'metadata_unavailable',
        badge: null,
        source: 'chain',
        queriedAt: new Date().toISOString()
      });
    }

    // Step 3 — compute trust score from on-chain fields
    const score = computeTrustScore(fields.issue_date, fields.update_count);

    return res.status(200).json({
      address,
      isVerified: true,
      isActive: true,
      trustScore: score.total,
      riskScore: Math.max(0, 100 - score.total),
      badgeStatus: 'active',
      badge: {
        objectId: badgeObjectId,
        creatorName: fields.creator_name,
        creatorAddress: fields.creator_address,
        issueDate: Number(fields.issue_date),
        updateCount: Number(fields.update_count),
        soulbound: true,
        package: PACKAGE_ID,
        registry: REGISTRY_ID,
        suiscanUrl: `https://suiscan.xyz/testnet/object/${badgeObjectId}`
      },
      scoreBreakdown: {
        base: score.base,
        ageBonus: score.ageBonus,
        ageDays: score.ageDays,
        activityBonus: score.activityBonus,
        updateCount: Number(fields.update_count),
        formula: 'base(60) + min(25, floor(ageDays/7)) + min(15, updates*3)'
      },
      source: 'chain',
      queriedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[score] error:', err.message);
    return res.status(503).json({
      error: 'Chain query failed',
      message: err.message,
      hint: 'Sui testnet RPC may be temporarily unavailable'
    });
  }
};
