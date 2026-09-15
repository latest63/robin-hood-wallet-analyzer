// GMGN API integration via Vercel Serverless Function proxy
// Routes through VPS backend which uses gmgn-cli (bypasses Cloudflare)

const API_BASE = '/api/gmgn-proxy'

export const scanToken = async (tokenAddress) => {
  try {
    // Get token info
    const tokenResp = await fetch(`${API_BASE}?action=info&chain=robinhood&address=${tokenAddress}`)
    const tokenData = await tokenResp.json()

    if (!tokenData || tokenData.error) {
      throw new Error(tokenData.error || 'Token not found')
    }

    // Get traders sorted by profit
    const tradersResp = await fetch(`${API_BASE}?action=traders&chain=robinhood&address=${tokenAddress}&limit=50`)
    const tradersData = await tradersResp.json()

    let traderList = []
    if (tradersData && tradersData.list) {
      traderList = tradersData.list
        .filter(t => {
          const tags = t.tags || []
          return !tags.includes('sandwich_bot') && !tags.includes('sniper')
        })
        .map(t => ({
          wallet: t.address,
          profit: t.profit || 0,
          pnl_pct: t.realized_pnl || 0,
          buys: t.buy_tx_count_cur || 0,
          tags: t.tags || [],
          selected: (t.profit || 0) > 1000
        }))
    }

    return {
      token: tokenData,
      traders: traderList
    }
  } catch (error) {
    console.error('GMGN API Error:', error)
    throw error
  }
}

export const getWalletActivity = async (walletAddress) => {
  try {
    const resp = await fetch(`${API_BASE}?action=activity&chain=robinhood&wallet=${walletAddress}&limit=10`)
    const data = await resp.json()
    return data?.list || []
  } catch (error) {
    console.error('GMGN Activity Error:', error)
    return []
  }
}
