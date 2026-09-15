// Vercel Serverless Function to proxy GMGN API calls
// Routes through VPS backend which uses gmgn-cli (bypasses Cloudflare)

const VPS_BACKEND = 'http://43.131.63.160:8899'

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  try {
    const { action, chain, address, limit } = req.method === 'POST' ? req.body : req.query

    if (!action) {
      return res.status(400).json({ error: 'Missing action parameter' })
    }

    let vpsUrl
    if (action === 'traders') {
      if (!address) return res.status(400).json({ error: 'Missing address' })
      vpsUrl = `${VPS_BACKEND}/api/token/traders?chain=${chain || 'robinhood'}&address=${address}&limit=${limit || 20}`
    } else if (action === 'info') {
      if (!address) return res.status(400).json({ error: 'Missing address' })
      vpsUrl = `${VPS_BACKEND}/api/token/info?chain=${chain || 'robinhood'}&address=${address}`
    } else if (action === 'trending') {
      vpsUrl = `${VPS_BACKEND}/api/market/trending?chain=${chain || 'robinhood'}&limit=${limit || 10}`
    } else {
      return res.status(400).json({ error: `Unknown action: ${action}` })
    }

    console.log('Calling VPS:', vpsUrl)

    const response = await fetch(vpsUrl, {
      signal: AbortSignal.timeout(25000)
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('VPS error:', response.status, errorText)
      return res.status(response.status).json({ 
        error: 'Backend error: ' + response.status, 
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
