// Explorer-based early buyers scanner (Node.js)
const _HEX = Buffer.from([48, 120]).toString(); // "0x"

const EXPLORER_URLS = {
  mainnet: "https://robinhoodchain.blockscout.com/api/v2",
  testnet: "https://explorer.testnet.chain.robinhood.com/api/v2"
};

function toLower(hex) {
  return hex.toLowerCase();
}

// Fetch paginated transactions from explorer
async function fetchTransactions(address, network, limit = 100) {
  const explorerUrl = EXPLORER_URLS[network] || EXPLORER_URLS.mainnet;
  const allTxs = [];
  let offset = 0;
  
  while (true) {
    const resp = await fetch(`${explorerUrl}/addresses/${address}/transactions?page[size]=${limit}&page[offset]=${offset}`);
    const data = await resp.json();
    const txs = data.items || [];
    
    if (txs.length === 0) break;
    allTxs.push(...txs);
    
    // If we got fewer than limit, we've reached the end
    if (txs.length < limit) break;
    offset += limit;
    
    // Safety limit - don't fetch more than 1000 transactions
    if (allTxs.length >= 1000) break;
  }
  
  return allTxs;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  
  try {
    const { address, network = "mainnet" } = req.method === "POST" ? req.body : req.query;
    if (!address?.startsWith(_HEX)) {
      return res.status(400).json({ error: "Invalid address" });
    }
    
    const isTestnet = network === "testnet";
    console.log(`Scanning ${network}:`, address);
    
    // Build address safely
    const TOKEN = toLower(address);
    
    let allBuyers = {};
    let logCount = 0;
    
    // Use explorer API to get token data and transfers
    try {
      // Get token info
      const tokenResp = await fetch(`https://${isTestnet ? 'explorer.testnet' : 'robinhoodchain.blockscout'}.com/api/v2/addresses/${TOKEN}`);
      const tokenData = await tokenResp.json();
      
      let tokenName = TOKEN;
      let tokenSymbol = 'TOKEN';
      let holdersCount = 0;
      
      if (tokenData.token) {
        tokenName = tokenData.token.name || tokenName;
        tokenSymbol = tokenData.token.symbol || tokenSymbol;
        holdersCount = parseInt(tokenData.token.holders_count || '0');
      }
      
      // Get transactions with token transfers
      const txs = await fetchTransactions(TOKEN, network);
      console.log(`Fetched ${txs.length} transactions from explorer`);
      
      // Process each transaction to find transfers
      for (const tx of txs) {
        if (!tx.token_transfers) continue;
        
        for (const transfer of tx.token_transfers) {
          const fromAddr = (transfer.sender || "").toLowerCase();
          const toAddr = (transfer.receiver || "").toLowerCase();
          const amount = BigInt(transfer.value || "0");
          const blockNum = parseInt(transfer.block_number || "0");
          
          if (!amount || amount === 0n) continue;
          
          if (!allBuyers[toAddr]) {
            allBuyers[toAddr] = { total: 0n, firstBlock: blockNum, sources: {} };
          }
          allBuyers[toAddr].total += amount;
          allBuyers[toAddr].sources[fromAddr] = (allBuyers[toAddr].sources[fromAddr] || 0) + 1;
          logCount++;
        }
      }
      
      console.log(`Explorer scan complete. Unique wallets: ${Object.keys(allBuyers).length}, transfers: ${logCount}`);
      
      const sorted = Object.entries(allBuyers)
        .sort((a, b) => a[1].firstBlock - b[1].firstBlock);
      
      // Testnet shows top 5, mainnet shows top 20
      const limit = isTestnet ? 5 : 20;
      
      return res.status(200).json({
        token: TOKEN,
        tokenName: tokenName,
        tokenSymbol: tokenSymbol,
        totalTransfers: logCount,
        uniqueWallets: sorted.length,
        holdersCount: holdersCount || sorted.length,
        network: network,
        earlyBuyers: (sorted || []).slice(0, limit).map(([addr, info]) => ({
          wallet: addr,
          amount: Number(info.total) / 1e18,
          block: info.firstBlock
        }))
      });
      
    } catch (e) {
      console.error("Explorer API failed:", e.message);
      return res.status(500).json({ error: `Failed to fetch from explorer: ${e.message}` });
    }
    
  } catch (error) {
    console.error("Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
}
