// FILE PATH IN REPO: api/apply.js
// Receives application form submissions and writes to Supabase
// Required environment variables (set in Vercel dashboard):
//   SUPABASE_URL      — https://your-project.supabase.co
//   SUPABASE_ANON_KEY — your anon public key

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL      = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[apply] Missing Supabase env vars');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Parse body — handles both string and pre-parsed JSON
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { wallet_address, protocol_name, audit_url, contact_email, description } = body || {};

  // Validate required fields
  if (!wallet_address || !protocol_name) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['wallet_address', 'protocol_name']
    });
  }

  // Validate Sui address format — flexible, accepts short and full addresses
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(wallet_address)) {
    return res.status(400).json({
      error: 'Invalid wallet address',
      hint: 'Must be a valid Sui address starting with 0x'
    });
  }

  try {
    const supabaseRes = await fetch(`${SUPABASE_URL}/rest/v1/applications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        wallet_address: wallet_address.toLowerCase().trim(),
        protocol_name: protocol_name.trim(),
        audit_url: audit_url?.trim() || null,
        contact_email: contact_email?.trim() || null,
        description: description?.trim() || null,
        status: 'pending',
        submitted_at: new Date().toISOString(),
      }),
    });

    if (!supabaseRes.ok) {
      const errBody = await supabaseRes.json().catch(() => ({}));
      console.error('[apply] Supabase error:', errBody);

      // Duplicate wallet address
      if (supabaseRes.status === 409 || errBody?.code === '23505') {
        return res.status(409).json({
          error: 'Already applied',
          message: 'An application for this wallet address already exists. The committee will be in touch.'
        });
      }

      throw new Error(`Supabase responded with ${supabaseRes.status}`);
    }

    const records = await supabaseRes.json();
    const record = Array.isArray(records) ? records[0] : records;

    return res.status(201).json({
      success: true,
      message: 'Application received. The Omen committee will review within 48 hours.',
      applicationId: record?.id || null,
      submittedAt: record?.submitted_at || new Date().toISOString(),
      walletAddress: wallet_address,
      status: 'pending'
    });

  } catch (err) {
    console.error('[apply] error:', err.message);
    return res.status(503).json({
      error: 'Failed to submit application',
      message: err.message
    });
  }
};
