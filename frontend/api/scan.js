// RPC-based early buyers scanner (Node.js) - with Explorer API fallback for testnet
const _HEX = Buffer.from([48, 120]).toString(); // "0x"
const TRANSFER_TOPIC = _HEX + "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const RPC_URLS = {
  mainnet: "https://rpc.mainnet.chain.robinhood.com",
  testnet: "https://rpc.testnet.chain.robinhood.com"
};

const EXPLORER_URLS = {
  mainnet: "https://robinhoodchain.blockscout.com/api/v2",
  testnet: "https://explorer.testnet.chain.robinhood.com/api/v2"
};

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
  const h = BigInt(val).toString(16);
  return _HEX + h;
}

function toLower(hex) {
  return hex.toLowerCase();
}

// Use Explorer API for testnet to get all historical data quickly
async function scanWithExplorer(TOKEN, network) {
  const explorerUrl = EXPLORER_URLS[network];
  const address = TOKEN.toLowerCase();
  
  // Get transactions by address
  const txsResp = await fetch(`${explorerUrl}/addresses/${address}/transactions`);
  const txsData = await txsResp.json();
  const txs = txsData.data || [];
  
  // Filter for transfer events (send method)
  const transfers = txs.filter(tx => tx.method === 'transfer' || tx.method === 'Transfer');
  
  // Build buyers map from transfers
  const allBuyers = {};
  let logCount = 0;
  
  for (const tx of transfers) {
    if (!tx.transfers) continue;
    for (const transfer of tx.transfers) {
      if (transfer.token_symbol === undefined) continue;
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
  
  console.log(`Explorer scan done. Unique wallets: ${Object.keys(allBuyers).length}, transfers: ${logCount}`);
  
  return { allBuyers, logCount };
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
    const isMainnet = !isTestnet;
    console.log(`Scanning ${network}:`, address);
    
    // Build address safely
    const TOKEN = toLower(address);
    
    let allBuyers = {};
    let logCount = 0;
    
    if (isTestnet) {
      // Testnet: scan from block 0 to capture all historical data
      const blockHex = await rpcCall("eth_blockNumber", [], "testnet");
      const current = parseInt(blockHex, 16);
      console.log(`Testnet current block: ${current}`);
      
      // Testnet has limited history - scan from ~73M where token first appeared
      // Data confirmed in blocks 0x4700000-0x7600000 (73M-76M)
      const START_BLOCK = 0x4700000; // 73081856
      const chunkSize = 50000;
      const startTime = Date.now();
      
      for (let start = START_BLOCK; start <= current; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, current);
        const logs = await rpcCall("eth_getLogs", [{
          fromBlock: ethHex(start),
          toBlock: ethHex(end),
          address: TOKEN,
          topics: [TRANSFER_TOPIC]
        }], "testnet");
        
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
        
        // Progress report every 100K blocks or 10s
        if ((start % 100000 === 0 || (Date.now() - startTime) > 10000) && start > 0) {
          const pct = (start / current * 100).toFixed(1);
          console.log(`Progress: ${pct}% (${logCount} logs)`);
        }
      }
      
      console.log(`Testnet scan complete. Unique wallets: ${Object.keys(allBuyers).length}, transfers: ${logCount}`);
    } else {
      // Mainnet: use RPC scan
      const blockHex = await rpcCall("eth_blockNumber", [], "mainnet");
      const current = parseInt(blockHex, 16);
      
      // Mainnet uses fixed starting point
      const maxBlocks = 200000;
      const fromBlock = Math.max(current - maxBlocks, 69200000);
      
      const startTime = Date.now();
      
      for (let start = fromBlock; start < current && start < fromBlock + maxBlocks; start += 2000) {
        const end = Math.min(start + 2000, current, fromBlock + maxBlocks);
        const logs = await rpcCall("eth_getLogs", [{
          fromBlock: ethHex(start),
          toBlock: ethHex(end),
          address: TOKEN,
          topics: [TRANSFER_TOPIC]
        }], "mainnet");
        
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
        process.stdout.write(`\rProgress: ${pct}% (${logCount} logs)`);
      }
      
      console.log(`\nDone. Unique wallets: ${Object.keys(allBuyers).length}`);
    }
    
    const sorted = Object.entries(allBuyers)
      .sort((a, b) => a[1].firstBlock - b[1].firstBlock);
    
    // Fetch token name and symbol from RPC
    let tokenName = TOKEN;
    let tokenSymbol = 'TOKEN';
    try {
      const nameResult = await rpcCall("eth_call", [{
        to: TOKEN,
        data: _HEX + "06fdde03"
      }, "latest", "mainnet"]);
      if (nameResult && nameResult.length > 130) {
        const fullHex = nameResult.slice(2);
        const length = parseInt(fullHex.slice(64, 128), 16);
        const strHex = fullHex.slice(128, 128 + length * 2);
        tokenName = Buffer.from(strHex, 'hex').toString('utf8');
      }
    } catch(e) {}
    try {
      const symResult = await rpcCall("eth_call", [{
        to: TOKEN,
        data: _HEX + "95d89b41"
      }, "latest", "mainnet"]);
      if (symResult && symResult.length > 130) {
        const fullHex = symResult.slice(2);
        const length = parseInt(fullHex.slice(64, 128), 16);
        const strHex = fullHex.slice(128, 128 + length * 2);
        tokenSymbol = Buffer.from(strHex, 'hex').toString('utf8');
      }
    } catch(e) {}
    
    // Testnet shows top 5, mainnet shows top 20
    const limit = isTestnet ? 5 : 20;
    
    return res.status(200).json({
      token: TOKEN,
      tokenName: tokenName,
      tokenSymbol: tokenSymbol,
      totalTransfers: logCount,
      uniqueWallets: sorted.length,
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
