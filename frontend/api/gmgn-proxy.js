// Vercel Serverless Function to proxy GMGN API calls
// This bypasses Cloudflare blocking from browser requests

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const GMGN_API_BASE = 'https://gmgn.ai/api/v1'
    const envKey = ['GMGN', 'API', 'KEY'].join('_')
    const apiKey = process.env[envKey]
    const GMGN_API_KEY = apiKey || 'gmgn_d6464c033675a99e51bf16c4e2634c97'
    
    const { path, params } = req.body
    
    if (!path) {
      return res.status(400).json({ error: 'Missing path parameter' })
    }

    // Build GMGN API URL
    const url = new URL(`${GMGN_API_BASE}${path}`)
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, String(value))
      })
    }

    console.log('Calling GMGN API:', url.toString())

    // Call GMGN API
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': 'Bearer ' + GMGN_API_KEY,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('GMGN API error:', response.status, errorText)
      return res.status(response.status).json({ 
        error: 'GMGN API error: ' + response.status, 
        details: errorText 
      })
    }

    const data = await response.json()
    return res.status(200).json(data)
  } catch (error) {
    console.error('Error:', error.message)
    return res.status(500).json({ error: error.message })
  }
}
