// Vercel Serverless Function - GMGN API Proxy
// Uses gmgn-cli's OpenApiClient directly to bypass Cloudflare

// Import gmgn-cli's client directly
const { OpenApiClient } = await import('gmgn-cli/dist/client/OpenApiClient.js').catch(() => null) || {};

// Fallback: use undici with same TLS fingerprint
import { Agent, setGlobalDispatcher, buildConnector } from 'undici';

// Force IPv4 + custom TLS fingerprint (same as gmgn-cli)
const connector = buildConnector({ family: 4 });
const dispatcher = new Agent({ connect: connector });
setGlobalDispatcher(dispatcher);

const GMGN_API_KEY = process.env.GMGN_API_KEY || 'gmgn_d6464c033675a99e51bf16c4e2634c97';
const GMGN_HOST = 'https://openapi.gmgn.ai';

// Build auth query params (same as gmgn-cli)
function buildAuthQuery() {
  return {
    timestamp: Math.floor(Date.now() / 1000).toString(),
    client_id: 'gmgn-cli'
  };
}

// Make authenticated request to GMGN OpenAPI
async function gmgnRequest(path, params = {}) {
  const { timestamp, client_id } = buildAuthQuery();
  const query = { ...params, timestamp, client_id };
  
  const url = new URL(`${GMGN_HOST}${path}`);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  console.log('GMGN request:', url.toString());

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-APIKEY': GMGN_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'gmgn-cli/1.6.4'
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
    const { action, chain, address, limit, orderby, direction, tag } = 
      req.method === 'POST' ? req.body : req.query;

    if (!action) {
      return res.status(400).json({ error: 'Missing action parameter' });
    }

    let data;
    const chainId = chain || 'robinhood';

    switch (action) {
      case 'traders':
        if (!address) return res.status(400).json({ error: 'Missing address' });
        data = await gmgnRequest('/v1/market/token_top_traders', {
          chain: chainId,
          address,
          limit: limit || 50,
          order_by: orderby || 'profit',
          direction: direction || 'desc',
          ...(tag ? { tag } : {})
        });
        break;

      case 'info':
        if (!address) return res.status(400).json({ error: 'Missing address' });
        data = await gmgnRequest('/v1/token/info', {
          chain: chainId,
          address
        });
        break;

      case 'trending':
        data = await gmgnRequest('/v1/market/trending', {
          chain: chainId,
          limit: limit || 10,
          interval: '1h'
        });
        break;

      case 'holders':
        if (!address) return res.status(400).json({ error: 'Missing address' });
        data = await gmgnRequest('/v1/market/token_top_holders', {
          chain: chainId,
          address,
          limit: limit || 20,
          order_by: orderby || 'amount_percentage',
          direction: direction || 'desc'
        });
        break;

      case 'activity':
        if (!address) return res.status(400).json({ error: 'Missing address' });
        data = await gmgnRequest('/v1/user/wallet_activity', {
          chain: chainId,
          wallet_address: address,
          limit: limit || 20
        });
        break;

      case 'score':
        if (!address) return res.status(400).json({ error: 'Missing address' });
        data = await gmgnRequest('/v1/user/wallet_score', {
          chain: chainId,
          wallet_address: address
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
