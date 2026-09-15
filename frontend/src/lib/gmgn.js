// GMGN API integration
// Replace gmgn-cli with direct API calls

const GMGN_API_BASE = 'https://gmgn.ai/api/v1';

export const scanToken = async (tokenAddress) => {
  try {
    // Get token info
    const tokenResp = await fetch(`${GMGN_API_BASE}/tokens/info?chain=robinhood&address=${tokenAddress}`);
    const tokenData = await tokenResp.json();
    
    if (!tokenData.data) {
      throw new Error('Token not found');
    }

    // Get traders sorted by profit
    const tradersResp = await fetch(
      `${GMGN_API_BASE}/tokens/traders?chain=robinhood&address=${tokenAddress}&order_by=profit&direction=desc&limit=50`
    );
    const tradersData = await tradersResp.json();

    let traderList = [];
    if (tradersData.data && tradersData.data.list) {
      traderList = tradersData.data.list
        .filter(t => {
          const tags = t.tags || [];
          return !tags.includes('sandwich_bot') && !tags.includes('sniper');
        })
        .map(t => ({
          wallet: t.address,
          profit: t.profit || 0,
          pnl_pct: t.realized_pnl || 0,
          buys: t.buy_tx_count_cur || 0,
          tags: t.tags || [],
          selected: (t.profit || 0) > 1000
        }));
    }

    return {
      token: tokenData.data,
      traders: traderList
    };
  } catch (error) {
    console.error('GMGN API Error:', error);
    throw error;
  }
};

export const getWalletActivity = async (walletAddress) => {
  try {
    const resp = await fetch(
      `${GMGN_API_BASE}/portfolio/activity?chain=robinhood&wallet=${walletAddress}&limit=10`
    );
    const data = await resp.json();
    return data.data?.list || [];
  } catch (error) {
    console.error('GMGN Activity Error:', error);
    return [];
  }
};
