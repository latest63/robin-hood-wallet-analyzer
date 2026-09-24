// Explorer-based early buyers scanner (Node.js)
const _HEX = Buffer.from([48, 120]).toString(); // "0x"

const EXPLORER_URLS = {
  testnet: "https://explorer.testnet.chain.robinhood.com/api/v2"
};

const RPC_URLS = {
  mainnet: "https://rpc.mainnet.chain.robinhood.com",
  testnet: "https://rpc.testnet.chain.robinhood.com"
};

function toLower(hex) {
  return hex.toLowerCase();
}

// Testnet: Use Explorer API
async function scanWithExplorer(TOKEN) {
  const allBuyers = {};
  let logCount = 0;
  
  // Fetch token info
  const tokenResp = await fetch(`https://explorer.testnet.chain.robinhood.com/api/v2/addresses/${TOKEN}`);
  const tokenData = await tokenResp.json();
  
  let tokenName = TOKEN;
  let tokenSymbol = 'TOKEN';
  let holdersCount = 0;
  
  if (tokenData.token) {
    tokenName = tokenData.token.name || tokenName;
    tokenSymbol = tokenData.token.symbol || tokenSymbol;
    holdersCount = parseInt(tokenData.token.holders_count || '0');
  }
  
  // Fetch transactions from explorer
  const txsResp = await fetch(`https://explorer.testnet.chain.robinhood.com/api/v2/addresses/${TOKEN}/transactions?page[size]=100&page[offset]=0`);
  const txsData = await txsResp.json();
  let txs = txsData.items || [];
  
  // Process transfers
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
  
  return { allBuyers, logCount, tokenName, tokenSymbol, holdersCount };
}

// Mainnet/Testnet: Use RPC with wider block range
async function scanWithRPC(TOKEN, network) {
  const rpcUrl = RPC_URLS[network] || RPC_URLS.mainnet;
  const TRANSFER_TOPIC = _HEX + "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  
  async function rpcCall(method, params, retries = 5) {
    const url = network === "testnet" ? RPC_URLS.testnet : RPC_URLS.mainnet;
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
  
  const allBuyers = {};
  let logCount = 0;
  
  // Get current block
  const blockHex = await rpcCall("eth_blockNumber", []);
  const current = parseInt(blockHex, 16);
  
  // Use wide range for RPC
  const START_BLOCK = Math.max(current - 500000, 100000000);
  const chunkSize = 10000;
  
  for (let start = START_BLOCK; start <= current; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, current);
    const logs = await rpcCall("eth_getLogs", [{
      fromBlock: ethHex(start),
      toBlock: ethHex(end),
      address: TOKEN,
      topics: [TRANSFER_TOPIC]
    }]);
    
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
  
  // Get token name/symbol from RPC
  let tokenName = TOKEN;
  let tokenSymbol = 'TOKEN';
  try {
    const nameResult = await rpcCall("eth_call", [{ to: TOKEN, data: _HEX + "06fdde03" }]);
    if (nameResult && nameResult.length > 130) {
      const fullHex = nameResult.slice(2);
      const length = parseInt(fullHex.slice(64, 128), 16);
      const strHex = fullHex.slice(128, 128 + length * 2);
      tokenName = Buffer.from(strHex, 'hex').toString('utf8');
    }
  } catch(e) {}
  try {
    const symResult = await rpcCall("eth_call", [{ to: TOKEN, data: _HEX + "95d89b41" }]);
    if (symResult && symResult.length > 130) {
      const fullHex = symResult.slice(2);
      const length = parseInt(fullHex.slice(64, 128), 16);
      const strHex = fullHex.slice(128, 128 + length * 2);
      tokenSymbol = Buffer.from(strHex, 'hex').toString('utf8');
    }
  } catch(e) {}
  
  console.log(`RPC scan complete. Unique wallets: ${Object.keys(allBuyers).length}, transfers: ${logCount}`);
  
  return { allBuyers, logCount, tokenName, tokenSymbol, holdersCount: Object.keys(allBuyers).length };
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
    
    let result;
    if (isTestnet) {
      // Testnet: Use Explorer API
      result = await scanWithExplorer(TOKEN);
    } else {
      // Mainnet: Use RPC (blockscout has Cloudflare protection)
      result = await scanWithRPC(TOKEN, "mainnet");
    }
    
    const { allBuyers, logCount, tokenName, tokenSymbol, holdersCount } = result;
    
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
