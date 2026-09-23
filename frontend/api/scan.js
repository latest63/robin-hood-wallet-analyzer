// RPC-based early buyers scanner (Node.js)
const _HEX = Buffer.from([48, 120]).toString(); // "0x"
const TRANSFER_TOPIC = _HEX + "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const POOL_MANAGER = _HEX + "8366a39cc670b4001a1121b8f6a443a643e40951";

async function rpcCall(method, params, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch("https://rpc.mainnet.chain.robinhood.com", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 })
      });
      if (res.status === 429) {
        const delay = 3000 * (i + 1);
        console.log(`Rate limited, waiting ${delay}ms...`);
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
  // Use bigint to avoid leading zeros
  const h = BigInt(val).toString(16);
  return _HEX + h;
}

function toLower(hex) {
  return hex.toLowerCase();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  
  try {
    const { address } = req.method === "POST" ? req.body : req.query;
    if (!address?.startsWith(_HEX)) {
      return res.status(400).json({ error: "Invalid address" });
    }
    
    // Build address safely without using substring
    const TOKEN=toLower(address);
    console.log("Scanning:", TOKEN);
    
    const blockHex = await rpcCall("eth_blockNumber", []);
    const current = parseInt(blockHex, 16);
    
    // Use smaller range and chunks to avoid rate limits
    const maxBlocks = 200000;
    const fromBlock = Math.max(current - maxBlocks, 69200000);
    
    const allBuyers = {};
    let logCount = 0;
    const startTime = Date.now();
    
    for (let start = fromBlock; start < current && start < fromBlock + maxBlocks; start += 2000) {
      const end = Math.min(start + 2000, current, fromBlock + maxBlocks);
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
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const pct = ((start - fromBlock) / Math.min(maxBlocks, current - fromBlock) * 100).toFixed(0);
      process.stdout.write("\rProgress: " + pct + "% (" + logCount + " logs)");
    }
    
    console.log("\nDone. Unique wallets:", Object.keys(allBuyers).length);
    
    const sorted = Object.entries(allBuyers)
      .sort((a, b) => a[1].firstBlock - b[1].firstBlock);
    
    // Fetch token name and symbol from RPC
    let tokenName = TOKEN;
    let tokenSymbol = 'TOKEN';
    try {
      const nameResult = await rpcCall("eth_call", [{
        to: TOKEN,
        data: _HEX + "06fdde03"
      }, "latest"]);
      if (nameResult) {
        // ERC20 name() returns: 0x + offset(64 chars) + length(64 chars) + bytes
        // Data starts at char 130 (after 0x + 64 + 64)
        const dataHex = nameResult.slice(130);
        const length = parseInt(dataHex.slice(0, 64), 16);
        const strHex = dataHex.slice(64, 64 + length * 2);
        tokenName = Buffer.from(strHex, 'hex').toString('utf8');
      }
    } catch(e) {}
    try {
      const symResult = await rpcCall("eth_call", [{
        to: TOKEN,
        data: _HEX + "95d89b41"
      }, "latest"]);
      if (symResult) {
        const dataHex = symResult.slice(130);
        const length = parseInt(dataHex.slice(0, 64), 16);
        const strHex = dataHex.slice(64, 64 + length * 2);
        tokenSymbol = Buffer.from(strHex, 'hex').toString('utf8');
      }
    } catch(e) {}

    return res.status(200).json({
      token: TOKEN,
      tokenName: tokenName,
      tokenSymbol: tokenSymbol,
      totalTransfers: logCount,
      uniqueWallets: sorted.length,
      earlyBuyers: (sorted || []).slice(0, 20).map(([addr, info]) => ({
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
