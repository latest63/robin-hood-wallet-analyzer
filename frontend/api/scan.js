// RPC-based early buyers scanner (Node.js) with dynamic creation block detection
const _HEX = Buffer.from([48, 120]).toString(); // "0x"

const RPC_URLS = {
  mainnet: "https://rpc.mainnet.chain.robinhood.com",
  testnet: "https://rpc.testnet.chain.robinhood.com"
};

const EXPLORER_URLS = {
  mainnet: "https://explorer.mainnet.chain.robinhood.com/api/v2",
  testnet: "https://explorer.testnet.chain.robinhood.com/api/v2"
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

async function explorerCall(endpoint, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(endpoint);
      if (res.status === 429) {
        const delay = 3000 * (i + 1);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return await res.json();
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

// Find token creation block using explorer API
async function findCreationBlock(tokenAddress, network) {
  try {
    const explorerUrl = EXPLORER_URLS[network];
    const addressData = await explorerCall(`${explorerUrl}/addresses/${tokenAddress}`);
    
    if (addressData?.creation_transaction_hash) {
      const txData = await explorerCall(`${explorerUrl}/transactions/${addressData.creation_transaction_hash}`);
      if (txData?.block_number) {
        console.log(`Token created at block ${txData.block_number}`);
        return txData.block_number;
      }
    }
    
    // Fallback: try to find first token transfer
    const transferData = await explorerCall(`${explorerUrl}/addresses/${tokenAddress}/token-transfers`);
    if (transferData?.items?.length > 0) {
      const oldestTransfer = transferData.items.sort((a, b) => a.block_number - b.block_number)[0];
      console.log(`No creation tx found, using first transfer at block ${oldestTransfer.block_number}`);
      return oldestTransfer.block_number;
    }
    
    return null;
  } catch (e) {
    console.log(`Explorer lookup failed: ${e.message}`);
    return null;
  }
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
    
    // Get current block
    const blockHex = await rpcCall("eth_blockNumber", [], network);
    const currentBlock = parseInt(blockHex, 16);
    console.log(`${network} current block: ${currentBlock}`);
    
    // Try to find exact creation block from explorer
    let startBlock = null;
    const creationBlock = await findCreationBlock(TOKEN, network);
    
    if (creationBlock) {
      startBlock = creationBlock;
      console.log(`Using discovery range: ${startBlock} to ${currentBlock}`);
    } else if (isTestnet) {
      // Fallback for testnet: wide range scan
      startBlock = Math.max(currentBlock - 10000000, 0); // Last 10M blocks
      console.log(`No creation block found, using fallback range: ${startBlock} to ${currentBlock}`);
    } else {
      // Mainnet: scan last 300K blocks
      startBlock = Math.max(currentBlock - 300000, 69000000);
      console.log(`No creation block found, using fallback range: ${startBlock} to ${currentBlock}`);
    }
    
    let allBuyers = {};
    let logCount = 0;
    let chunkSize = isTestnet ? 5000 : 2000;
    
    console.log(`Scanning ${((currentBlock - startBlock) / 1000000).toFixed(2)}M blocks...`);
    
    for (let start = startBlock; start <= currentBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, currentBlock);
      
      // Progress report every 500K blocks
      if (start % 500000 === 0 && start > 0) {
        console.log(`  Scanned ${((start - startBlock) / 1000000).toFixed(2)}M blocks, ${logCount} logs so far`);
      }
      
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
    
    console.log(`Total logs: ${logCount}`);
    
    // Get token metadata from explorer
    let tokenName = "TOKEN";
    let tokenSymbol = "";
    let holdersCount = 0;
    
    try {
      const metaData = await explorerCall(`${EXPLORER_URLS[network]}/addresses/${TOKEN}`);
      if (metaData?.name) tokenName = metaData.name;
      if (metaData?.token?.symbol) tokenSymbol = metaData.token.symbol;
      if (metaData?.token?.holders_count) holdersCount = parseInt(metaData.token.holders_count);
    } catch (e) {
      console.log(`Metadata fetch failed: ${e.message}`);
    }
    
    // Convert to sorted array
    const buyers = Object.entries(allBuyers)
      .map(([address, data]) => ({
        address,
        total: data.total.toString(),
        firstBlock: data.firstBlock,
        sources: Object.keys(data.sources)
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, isTestnet ? 5 : 20);
    
    const result = {
      address: address,
      name: tokenName,
      symbol: tokenSymbol,
      holders: holdersCount,
      totalTransfers: logCount,
      totalBuyers: Object.keys(allBuyers).length,
      startBlock,
      endBlock: currentBlock,
      topBuyers: buyers
    };
    
    console.log(`Scan complete: ${logCount} transfers, ${Object.keys(allBuyers).length} unique wallets`);
    return res.status(200).json(result);
    
  } catch (error) {
    console.error("Scan error:", error);
    return res.status(500).json({ error: error.message });
  }
}
