// Vercel Serverless Function - GMGN API Proxy
// Calls GMGN API directly from Vercel (no VPS backend needed)

const GMGN_BASE = 'https://gmgn.ai/api/v1';
const GMGN_TOKEN = process.env.GMGN_API_KEY || 'gmgn_d6464c033675a99e51bf16c4e2634c97';

// Simple in-memory rate limiter (per instance)
let lastRequestTime = 0;
const MIN_DELAY_MS = 2000; // 2 seconds between requests

async function gmgnFetch(path, params = {}) {
  // Rate limiting
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastRequestTime = Date.now();

  const url = new URL(`${GMGN_BASE}/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  console.log('GMGN request:', url.toString());

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${GMGN_TOKEN}`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://gmgn.ai/',
      'Origin': 'https://gmgn.ai'
    },
    signal: AbortSignal.timeout(25000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('GMGN error:', response.status, errorText.substring(0, 200));
    throw new Error(`GMGN API error: ${response.status}`);
  }

  return response.json();
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { action, chain, address, limit, orderby, direction } = 
      req.method === 'POST' ? req.body : req.query;

    if (!action) {
      return res.status(400).json({ error: 'Missing action parameter' });
    }

    let data;
    const chainId = chain || 'robinhood';

    switch (action) {
      case 'traders':
        if (!address) return res.status(400).json({ error: 'Missing address' });
        data = await gmgnFetch('token/traders', {
          chain: chainId,
          address,
          limit: limit || 50,
          order_by: orderby || 'profit',
          direction: direction || 'desc'
        });
        break;

      case 'info':
        if (!address) return res.status(400).json({ error: 'Missing address' });
        data = await gmgnFetch('token/info', {
          chain: chainId,
          address
        });
        break;

      case 'trending':
        data = await gmgnFetch('rank/overview/1h', {
          chain: chainId,
          limit: limit || 10,
          orderby: orderby || 'marketcap',
          direction: direction || 'desc'
        });
        break;

      case 'top':
        data = await gmgnFetch('rank/overview/1h', {
          chain: chainId,
          limit: limit || 20,
          orderby: orderby || 'marketcap',
          direction: direction || 'desc'
        });
        break;

      case 'new':
        data = await gmgnFetch('rank/overview/1h', {
          chain: chainId,
          limit: limit || 20,
          orderby: 'creation_time',
          direction: 'desc'
        });
        break;

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('Proxy error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
