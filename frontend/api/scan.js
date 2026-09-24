// Dynamic token creation block discovery with API key support
const _HEX = Buffer.from([48, 120]).toString();

const RPC_URLS = {
  mainnet: "https://rpc.mainnet.chain.robinhood.com",
  testnet: "https://rpc.testnet.chain.robinhood.com"
};

const EXPLORER_URLS = {
  mainnet: "https://explorer.mainnet.chain.robinhood.com/api/v2",
  testnet: "https://explorer.testnet.chain.robinhood.com/api/v2"
};

// Mainnet API key (from user)
const MAINNET_API_KEY = "proapi_crwp7Uu7Sba1wSCTkzGC51AX3UU7FiS7FlhohLzduPOdtchMy2b7oNY28Soi66uPi_b9hCiI";

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

async function explorerCall(endpoint, apiKey = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Basic ${apiKey}`;
      }
      
      const res = await fetch(endpoint, { headers });
      if (res.status === 429) {
        const delay = 3000 * (i + 1);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const text = await res.text();
      return JSON.parse(text);
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

// Binary search fallback if explorer fails
async function findCreationBlockBinarySearch(tokenAddress, currentBlock, network) {
  console.log("Binary searching for contract creation...");
  
  let low = 0;
  let high = currentBlock;
  let creationBlock = currentBlock;
  
  const maxIterations = 32;
  let iteration = 0;
  
  while (low <= high && iteration < maxIterations) {
    iteration++;
    const mid = Math.floor((low + high) / 2);
    
    const code = await rpcCall("eth_getCode", [tokenAddress, ethHex(mid)], network);
    
    if (code && code !== '0x' && code.length > 2) {
      creationBlock = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  
  console.log(`Contract creation found at approximately block ${creationBlock} (${iteration} iterations)`);
  return creationBlock;
}

// Get token metadata from explorer (with API key if available)
async function getTokenMetadata(tokenAddress, network) {
  const apiKey = network === 'mainnet' ? MAINNET_API_KEY : null;
  
  try {
    const metaData = await explorerCall(
      `${EXPLORER_URLS[network]}/addresses/${tokenAddress}`,
      apiKey
    );
    return {
      name: metaData?.name || "TOKEN",
      symbol: metaData?.token?.symbol || "",
      holders: parseInt(metaData?.token?.holders_count) || 0,
      creationTxHash: metaData?.creation_transaction_hash
    };
  } catch (e) {
    console.log(`Metadata fetch failed: ${e.message}`);
    return { name: "TOKEN", symbol: "", holders: 0, creationTxHash: null };
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
    console.log(`\n=== Scanning ${network}: ${address} ===`);
    
    const TOKEN=toLower(address);
    const TRANSFER_TOPIC = _HEX + "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    
    // Get current block
    const blockHex = await rpcCall("eth_blockNumber", [], network);
    const currentBlock = parseInt(blockHex, 16);
    console.log(`Current block: ${currentBlock.toLocaleString()}`);
    
    // Discover token creation block
    console.log("\n[1/3] Discovering token creation block...");
    
    // Try explorer first (faster with API key)
    let startBlock = null;
    let metadata = { name: "TOKEN", symbol: "", holders: 0 };
    
    try {
      metadata = await getTokenMetadata(TOKEN, network);
      
      if (metadata.creationTxHash) {
        const txResp = await explorerCall(
          `${EXPLORER_URLS[network]}/transactions/${metadata.creationTxHash}`,
          network === 'mainnet' ? MAINNET_API_KEY : null
        );
        
        if (txResp?.block_number) {
          startBlock = txResp.block_number;
          console.log(`✓ Found creation block via explorer: ${startBlock.toLocaleString()}`);
        }
      }
    } catch (e) {
      console.log(`Explorer discovery failed: ${e.message}, using RPC binary search`);
    }
    
    // Fallback to binary search if explorer didn't work
    if (!startBlock) {
      console.log("Using RPC binary search for creation block...");
      startBlock = await findCreationBlockBinarySearch(TOKEN, currentBlock, network);
    }
    
    // Scan transfers
    console.log(`\n[2/3] Scanning blocks ${startBlock.toLocaleString()} to ${currentBlock.toLocaleString()}...`);
    
    let allBuyers = {};
    let logCount = 0;
    const chunkSize = isTestnet ? 5000 : 2000;
    const totalBlocks = currentBlock - startBlock;
    
    console.log(`Total range: ${totalBlocks.toLocaleString()} blocks (${(totalBlocks/1000000).toFixed(2)}M)`);
    
    for (let start = startBlock; start <= currentBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, currentBlock);
      
      // Progress every 500K blocks
      if ((start - startBlock) % 500000 === 0 && start > startBlock) {
        const progress = ((start - startBlock) / totalBlocks * 100).toFixed(1);
        console.log(`  Progress: ${progress}% (${logCount} logs)`);
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
    
    console.log(`\nScan complete: ${logCount} transfers from ${Object.keys(allBuyers).length} unique wallets`);
    
    // Format results (convert BigInt to string for JSON)
    const buyers = Object.entries(allBuyers)
      .map(([addr, data]) => ({
        address: addr,
        total: data.total.toString(),
        firstBlock: data.firstBlock,
        sourceCount: Object.values(data.sources).reduce((a, b) => a + b, 0)
      }))
      .sort((a, b) => {
        const aTotal = BigInt(a.total);
        const bTotal = BigInt(b.total);
        return bTotal > aTotal ? 1 : bTotal < aTotal ? -1 : 0;
      })
      .slice(0, isTestnet ? 5 : 20);
    
    const result = {
      token: address,
      tokenName: metadata.name,
      tokenSymbol: metadata.symbol,
      uniqueWallets: Object.keys(allBuyers).length,
      holdersCount: metadata.holders,
      totalTransfers: logCount,
      network,
      earlyBuyers: buyers.map(b => ({
        wallet: b.address,
        amount: b.total,
        block: b.firstBlock,
        timestamp: null
      }))
    };
    
    return res.status(200).json(result);
    
  } catch (error) {
    console.error("Scan error:", error);
    return res.status(500).json({ error: error.message });
  }
}
