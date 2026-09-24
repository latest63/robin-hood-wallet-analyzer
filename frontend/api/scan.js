// RPC-based early buyers scanner (Node.js)
const _HEX = Buffer.from([48, 120]).toString(); // "0x"

const RPC_URLS = {
  mainnet: "https://rpc.mainnet.chain.robinhood.com",
  testnet: "https://rpc.testnet.chain.robinhood.com"
};

function toLower(hex) {
  return hex.toLowerCase();
}

async function rpcCall(method, params, network = "mainnet", retries = 5) {
  const url = RPC_URLS[network] || RPC_URLS.mainnet;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 })
      });
      if (res.status === 429) {
        const delay = 3000 * (i + 1);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return (await res.json()).result;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

function ethHex(val) {
  const h = BigInt(val).toString(16);
  return _HEX + h;
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
    
    const TOKEN = toLower(address);
    const TRANSFER_TOPIC = _HEX + "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    
    let allBuyers = {};
    let logCount = 0;
    
    // Get current block
    const blockHex = await rpcCall("eth_blockNumber", [], network);
    const current = parseInt(blockHex, 16);
    console.log(`${network} current block: ${current}`);
    
    if (isTestnet) {
      // Testnet: scan from 117M blocks
      const START_BLOCK = 0x7000000; // 117,964,800
      const chunkSize = 10000;
      
      for (let start = START_BLOCK; start <= current; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, current);
        const logs = await rpcCall("eth_getLogs", [{
          fromBlock: ethHex(start),
          toBlock: ethHex(end),
          address: TOKEN,
          topics: [TRANSFER_TOPIC]
        }], network);
        
        if (!logs?.length) continue;
        logCount += logs.length;
        
        for (const log of logs) {
          const toAddr = _HEX + log.topics[2].substring(26).toLowerCase();
          const fromAddr = _HEX + log.topics[1].substring(26).toLowerCase();
          const amount = BigInt("0x" + (log.data || _HEX).substring(2));
          const blockNum = parseInt(log.blockNumber, 16);
          
          if (!allBuyers[toAddr]) {
            allBuyers[toAddr] = { total: 0n, firstBlock: blockNum, sources: {} };
          }
          allBuyers[toAddr].total += amount;
          allBuyers[toAddr].sources[fromAddr] = (allBuyers[toAddr].sources[fromAddr] || 0) + 1;
        }
      }
    } else {
      // Mainnet: scan last 300K blocks
      const START_BLOCK = Math.max(current - 300000, 69000000);
      const chunkSize = 2000;
      
      for (let start = START_BLOCK; start < current; start += chunkSize) {
        const end = Math.min(start + chunkSize, current);
        const logs = await rpcCall("eth_getLogs", [{
          fromBlock: ethHex(start),
          toBlock: ethHex(end),
          address: TOKEN,
          topics: [TRANSFER_TOPIC]
        }], network);
        
        if (!logs?.length) continue;
        logCount += logs.length;
        
        for (const log of logs) {
          const toAddr = _HEX + log.topics[2].substring(26).toLowerCase();
          const fromAddr = _HEX + log.topics[1].substring(26).toLowerCase();
          const amount = BigInt("0x" + (log.data || _HEX).substring(2));
          const blockNum = parseInt(log.blockNumber, 16);
          
          if (!allBuyers[toAddr]) {
            allBuyers[toAddr] = { total: 0n, firstBlock: blockNum, sources: {} };
          }
          allBuyers[toAddr].total += amount;
          allBuyers[toAddr].sources[fromAddr] = (allBuyers[toAddr].sources[fromAddr] || 0) + 1;
        }
      }
    }
    
    // Get token name/symbol from RPC
    let tokenName = TOKEN;
    let tokenSymbol = 'TOKEN';
    let holdersCount = Object.keys(allBuyers).length;
    
    // Try to get token info from explorer API
    try {
      const explorerUrl = isTestnet 
        ? `https://explorer.testnet.chain.robinhood.com/api/v2/addresses/${TOKEN}`
        : null;
      
      if (explorerUrl) {
        const resp = await fetch(explorerUrl);
        const data = await resp.json();
        if (data.token) {
          tokenName = data.token.name || tokenName;
          tokenSymbol = data.token.symbol || tokenSymbol;
          holdersCount = parseInt(data.token.holders_count || holdersCount);
        }
      }
    } catch(e) {
      // Fallback to RPC for name/symbol
      try {
        const nameResult = await rpcCall("eth_call", [{ to: TOKEN, data: _HEX + "06fdde03" }], network);
        if (nameResult && nameResult.length > 130) {
          const fullHex = nameResult.slice(2);
          const length = parseInt(fullHex.slice(64, 128), 16);
          const strHex = fullHex.slice(128, 128 + length * 2);
          tokenName = Buffer.from(strHex, 'hex').toString('utf8');
        }
      } catch(e) {}
      try {
        const symResult = await rpcCall("eth_call", [{ to: TOKEN, data: _HEX + "95d89b41" }], network);
        if (symResult && symResult.length > 130) {
          const fullHex = symResult.slice(2);
          const length = parseInt(fullHex.slice(64, 128), 16);
          const strHex = fullHex.slice(128, 128 + length * 2);
          tokenSymbol = Buffer.from(strHex, 'hex').toString('utf8');
        }
      } catch(e) {}
    }
    
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
      holdersCount: holdersCount,
      network: network,
      earlyBuyers: (sorted || []).slice(0, limit).map(([addr, info]) => ({
        wallet: addr,
        amount: Number(info.total) / 1e18,
        block: info.firstBlock
      }))
    });
  } catch (error) {
    console.error("Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
}
