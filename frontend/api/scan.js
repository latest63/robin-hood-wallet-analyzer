// Dynamic token launch-block discovery + launch-window scan.
// Gives the Vercel function enough time for the log-index binary search plus a
// bounded 200K-block scan (hobby tier caps at 60s, Pro up to 300s).
export const maxDuration = 180;

const _HEX = Buffer.from([48, 120]).toString();

const RPC_URLS = {
  mainnet: "https://rpc.mainnet.chain.robinhood.com",
  testnet: "https://rpc.testnet.chain.robinhood.com"
};

const EXPLORER_URLS = {
  mainnet: "https://explorer.mainnet.chain.robinhood.com/api/v2",
  testnet: "https://explorer.testnet.chain.robinhood.com/api/v2"
};

const POOL_MANAGER = _HEX + "8366a39cc670b4001a1121b8f6a443a643e40951";
const ZERO_ADDRESS = _HEX + "0000000000000000000000000000000000000000";

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
      const parsed = JSON.parse(text);
      // RHC explorers return HTTP 200 with {errors:[...]} on flaky misses —
      // treat that as a failure so the retry loop actually retries.
      if (parsed && (parsed.errors || parsed.error)) {
        const errText = JSON.stringify(parsed.errors || parsed.error);
        if (i === retries - 1) throw new Error(`Explorer error: ${errText.slice(0, 120)}`);
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      return parsed;
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

// Exploders return block_number as a JS decimal number on testnet and a
// decimal string on some Blockscout endpoints. Parse both, and also cope with
// a hex string ("0x...") just in case.
function parseExplorerBlock(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith(_HEX)) return parseInt(s, 16);
    return parseInt(s, 10);
  }
  return null;
}

// Raw RPC call that returns the full JSON-RPC body (so we can read the error
// field). rpcCall() above returns only .result and therefore swallows errors.
async function rpcCallFull(method, params, network = "mainnet", retries = 3) {
  const url = RPC_URLS[network] || RPC_URLS.mainnet;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 })
      });
      if (res.status === 429) {
        // Rate-limited — back off and retry.
        await new Promise(r => setTimeout(r, 3000 * (i + 1)));
        continue;
      }
      if (res.status >= 400) {
        // 403/502/503 from the load-balanced RHC RPC is TRANSIENT — it is NOT a
        // valid JSON-RPC result. Wrap it as an error so the caller's transient
        // retry loop actually retries (previously this returned res.json() and
        // the whole range was wrongly marked "undetermined").
        return { error: { code: res.status, message: `rpc http ${res.status}` } };
      }
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Fetch transfer logs for a block range. The RHC RPC caps eth_getLogs at
// 10,000 logs per call; when a chunk exceeds that, recursively split it in
// half and merge, so no transfer window is silently dropped.
// The testnet RPC load-balances nodes and *intermittently* rejects
// address-filtered ranges ("invalid hex string"), so transient errors are
// retried before falling back to splitting the chunk.
async function fetchTransferLogs(token, transferTopic, fromBlock, toBlock, network, _depth = 0) {
  if (fromBlock > toBlock) return [];
  const filter = {
    fromBlock: ethHex(fromBlock),
    toBlock: ethHex(toBlock),
    address: token,
    topics: [transferTopic]
  };
  let body = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    body = await rpcCallFull("eth_getLogs", [filter], network);
    if (!body || !body.error) return body?.result || [];
    const msg = String(body.error.message || body.error);
    // The 10k-log cap is deterministic, not flaky — stop retrying, split below.
    if (msg.includes("exceeds limit") || msg.includes("limit of")) break;
    // Transient node flakiness ("invalid hex string" on wide ranges is a known
    // load-balancer quirk of the RHC testnet RPC) — back off and retry.
    await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
  }
  if (body?.error) {
    const msg = String(body.error.message || body.error);
    if ((msg.includes("exceeds limit") || msg.includes("limit of")) && _depth < 20 && fromBlock !== toBlock) {
      // Split in half and merge — each half is under the cap.
      const mid = Math.floor((fromBlock + toBlock) / 2);
      const a = await fetchTransferLogs(token, transferTopic, fromBlock, mid, network, _depth + 1);
      const b = await fetchTransferLogs(token, transferTopic, mid + 1, toBlock, network, _depth + 1);
      return [...a, ...b];
    }
    // Persistent non-cap error (pruned state, unfixable node) — skip this
    // chunk rather than fan out thousands of doomed calls.
    console.log(`getLogs error [${fromBlock},${toBlock}] (depth ${_depth}): ${msg.slice(0, 120)}`);
    return [];
  }
  return body?.result || [];
}

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

// Locate the LAUNCH block — the first block containing a Transfer event.
// RHC mainnet prunes historical STATE (eth_getCode errors on old blocks) but
// the log index is retained from block 0, so we can pinpoint the launch via
// eth_getLogs. Coarse-to-fine: 4M windows from block 0 until the first
// non-empty one, then 100K sub-windows inside it. Cap errors (>10k logs in a
// window) are bisected; transient errors are retried. ~20 RPC calls total.
async function findLaunchBlockByLogs(token, transferTopic, currentBlock, network) {
  console.log("Locating launch block (first Transfer event) via log-index scan...");

  // Does [from..to] contain Transfer logs? Returns {logs: array|null}.
  // null = undetermined (RPC gave up after retries). Bisects the 10k cap.
  const hasLogs = async (from, to) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = await rpcCallFull("eth_getLogs", [{
        fromBlock: ethHex(from),
        toBlock: ethHex(to),
        address: token,
        topics: [transferTopic]
      }], network);
      if (!body || !body.error) return { logs: body?.result || [] };
      const msg = String(body.error.message || body.error);
      if (msg.includes("exceeds limit") || msg.includes("limit of") || msg.includes("10000")) {
        // >10k logs in this window — bisect, keep the leftmost non-empty side
        // (the global earliest always lives in the earliest non-empty sub-window).
        const mid = Math.floor((from + to) / 2);
        if (mid <= from) return { logs: [] };
        const left = await hasLogs(from, mid);
        if (left.logs && left.logs.length) return left;
        return hasLogs(mid + 1, to);
      }
      // transient (timeout / 429) — back off and retry the same range
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
    return { logs: null };
  };

  // 1) Coarse pass: 4M windows from 0 until the first non-empty.
  let targetFrom = null, targetTo = null;
  const COARSE = 4000000;
  outer:
  for (let s = 0; s <= currentBlock; s += COARSE) {
    const e = Math.min(s + COARSE - 1, currentBlock);
    let r = await hasLogs(s, e);
    if (r.logs === null) {
      // Undetermined (RPC gave up on this window). The launch may STILL be in
      // it. Probe 1M sub-windows; if any is confirmed non-empty, anchor the
      // tightest one. If every sub-window is undetermined too, anchor at the
      // window START — we have already proven every EARLIER window empty, so
      // the genesis (first non-empty window) must be here or later. NEVER skip
      // an undetermined window: that is what previously caused the scanner to
      // adopt the next (later) window and miss the true genesis.
      let anchored = false;
      for (let sub = s; sub <= e; sub += 1000000) {
        r = await hasLogs(sub, Math.min(sub + 999999, e));
        if (r.logs && r.logs.length) {
          targetFrom = sub; targetTo = Math.min(sub + 999999, e);
          anchored = true;
          break outer;
        }
        // r.logs null -> keep probing the next 1M sub-window
      }
      if (!anchored) {
        console.log(`Coarse window ${s.toLocaleString()} undetermined; anchoring scan at its start`);
        targetFrom = s; targetTo = e;
        break;
      }
      continue;
    }
    if (r.logs.length) { targetFrom = s; targetTo = e; break; }
  }

  if (!targetFrom) {
    console.log("No Transfer logs found anywhere; token may not exist on this network");
    return 0;
  }

  // 2) Fine pass: 100K windows inside [targetFrom, targetTo]
  let lo = targetFrom;
  while (lo <= targetTo) {
    const w = Math.min(lo + 99999, targetTo);
    const r = await hasLogs(lo, w);
    if (r.logs && r.logs.length) {
      r.logs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));
      const first = parseInt(r.logs[0].blockNumber, 16);
      console.log(`Launch block found: ${first.toLocaleString()}`);
      return first;
    }
    if (r.logs === null) {
      // undetermined 100K window — treat as possibly containing the launch:
      // stop and anchor at its start (safe: scanning a bit early is fine)
      console.log(`Log window undetermined at ${lo.toLocaleString()}; anchoring scan there`);
      return lo;
    }
    lo = w + 1;
  }
  return targetFrom;
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
      creationTxHash: metaData?.creation_transaction_hash,
      creatorAddress: metaData?.creator_address_hash // <-- ADD THIS
    };
  } catch (e) {
    console.log(`Metadata fetch failed: ${e.message}`);
    return { name: "TOKEN", symbol: "", holders: 0, creationTxHash: null, creatorAddress: null };
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
    
    const TOKEN = toLower(address); // Full lowercase address for RPC
    const TRANSFER_TOPIC = _HEX + "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    
    // Get current block
    const blockHex = await rpcCall("eth_blockNumber", [], network);
    const currentBlock = parseInt(blockHex, 16);
    console.log(`Current block: ${currentBlock.toLocaleString()}`);
    
    // Discover token creation block
    console.log("\n[1/3] Discovering token creation block...");
    
    // Bounded scan window (declared up-front so the discovery fallbacks below
    // can reference it without a temporal-dead-zone error).
    const MAX_SCAN_BLOCKS = 200000;

    // Try explorer first (faster with API key)
    let startBlock = null;
    let metadata = { name: "TOKEN", symbol: "", holders: 0 };
    let creatorAddress = null;
    
    try {
      metadata = await getTokenMetadata(TOKEN, network);
      creatorAddress = metadata.creatorAddress ? toLower(metadata.creatorAddress) : null;
      console.log(`DEBUG metadata: creationTx=${metadata.creationTxHash} creator=${creatorAddress} name=${metadata.name}`);
      
      // Only creationTxHash is needed to find the start block. Creator is
      // decoupled so a missing creator_address_hash doesn't block discovery.
      if (metadata.creationTxHash) {
        const txResp = await explorerCall(
          `${EXPLORER_URLS[network]}/transactions/${metadata.creationTxHash}`,
          network === 'mainnet' ? MAINNET_API_KEY : null
        );
        console.log(`DEBUG txResp.block_number=${txResp?.block_number} (type ${typeof txResp?.block_number})`);
        
        const txBlock = parseExplorerBlock(txResp?.block_number);
        if (txBlock != null) {
          startBlock = txBlock;
          console.log(`Found creation block via explorer: ${startBlock.toLocaleString()}`);
        }
      }
    } catch (e) {
      console.log(`Explorer discovery failed: ${e.message}, using RPC binary search`);
    }
    
    // Fallback when the explorer doesn't yield a creation block.
    //  - Testnet: RPC is pruned, so anchor at a recent window.
    //  - Mainnet: historical STATE is pruned (eth_getCode errors on old
    //    blocks), but the log index is retained from block 0 — so binary-search
    //    the FIRST Transfer event to find the real launch block. This is far
    //    more reliable than a pruned getCode search, which just gives up and
    //    lands on the current block.
    if (!startBlock) {
      if (isTestnet) {
        startBlock = Math.max(0, currentBlock - MAX_SCAN_BLOCKS);
        console.log(`Testnet: using recent-window fallback (last ${MAX_SCAN_BLOCKS.toLocaleString()} blocks)`);
      } else {
        startBlock = await findLaunchBlockByLogs(TOKEN, TRANSFER_TOPIC, currentBlock, network);
      }
    }
    
    // Scan transfers — bounded window so it always completes inside the
    // Vercel function timeout. Early buyers live in the launch window, so we
    // only scan the first MAX_SCAN_BLOCKS after the creation block.
    const scanEnd = Math.min(currentBlock, startBlock + MAX_SCAN_BLOCKS);
    // Large chunks keep the call count low; fetchTransferLogs recursively
    // splits any chunk that hits the RPC's 10k-log cap, so nothing is lost.
    const chunkSize = 20000;

    console.log(`\n[2/3] Scanning blocks ${startBlock.toLocaleString()} to ${scanEnd.toLocaleString()} (bounded to ${MAX_SCAN_BLOCKS.toLocaleString()})...`);

    // "Seed" = the deployer treasury that first received the supply straight
    // from the 0x0 mint (e.g. `0x0 -> 0x2bf8e7a1` at Denar's genesis). That
    // wallet is the ISSUER, not a buyer, so it must not be counted. Detect it
    // from the very first few blocks of the launch window (best-effort).
    let seedWallet = null;
    try {
      const seedLogs = await fetchTransferLogs(TOKEN, TRANSFER_TOPIC, startBlock, startBlock + 500, network);
      seedLogs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));
      for (const lg of seedLogs) {
        const from = _HEX + lg.topics[1].substring(26).toLowerCase();
        if (from === ZERO_ADDRESS) {
          seedWallet = _HEX + lg.topics[2].substring(26).toLowerCase();
          console.log(`Seed (issuer treasury) detected: ${seedWallet}`);
          break;
        }
      }
    } catch (e) { /* seed detection is best-effort; proceed without it */ }

    // Wallets that are infrastructure, not buyers: the mint source, the
    // PoolManager, the issuer seed, and (if known) the creator EOA.
    const notBuyer = addr =>
      addr === ZERO_ADDRESS || addr === POOL_MANAGER ||
      addr === seedWallet || (creatorAddress && addr === creatorAddress);

    let allBuyers = {};
    let logCount = 0;

    for (let start = startBlock; start <= scanEnd; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, scanEnd);
      
      // Progress every 50K blocks (scan window is bounded to 200K)
      if ((start - startBlock) % 50000 === 0 && start > startBlock) {
        const progress = ((start - startBlock) / (scanEnd - startBlock) * 100).toFixed(0);
        console.log(`  Progress: ${progress}% (${logCount} logs)`);
      }
      
      const logs = await fetchTransferLogs(TOKEN, TRANSFER_TOPIC, start, end, network);
      
      if (!logs?.length) continue;
      logCount += logs.length;
      
      for (const log of logs) {
        const toAddr = _HEX + log.topics[2].substring(26).toLowerCase();
        const fromAddr = _HEX + log.topics[1].substring(26).toLowerCase();
        const dataStr = (log.data && log.data.length > 2) ? log.data.substring(2) : "0";
        const amount = BigInt(_HEX + dataStr);
        const blockNum = parseInt(log.blockNumber, 16);

        // A "first buyer" is a real wallet that RECEIVED the token — not the
        // mint source (0x0), the PoolManager, or the issuer seed. Ranking
        // receipts by first-received block surfaces the earliest buyers first,
        // whether they got tokens from the seed distribution, the pool, or a
        // fresh mint.
        if (notBuyer(toAddr)) continue;
        
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
      .sort((a, b) => a.firstBlock - b.firstBlock) // earliest first = early buyers
      .slice(0, 20);
    
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
    
    // Test serialization before sending
    try {
      const testJson = JSON.stringify(result);
      console.log('Serialization test OK, length:', testJson.length);
    } catch (e) {
      console.error('JSON serialization failed:', e.message);
      // Debug: check each field
      for (const key of Object.keys(result)) {
        const val = result[key];
        if (val && typeof val === 'object') {
          for (const subKey of Object.keys(val)) {
            const subVal = val[subKey];
            if (typeof subVal === 'bigint') {
              console.error(`  Found BigInt at ${key}.${subKey}`);
              val[subKey] = subVal.toString();
            }
          }
        } else if (typeof val === 'bigint') {
          console.error(`  Found BigInt at ${key}`);
          result[key] = val.toString();
        }
      }
    }
    
    return res.status(200).json(result);
    
  } catch (error) {
    console.error("Scan error:", error);
    return res.status(500).json({ error: error.message });
  }
}
// Force redeploy

// DEBUG: BigInt fix deployed Thu Sep 24 09:12:22 PM CST 2026
// Deploy fix 1790255945
// Auto-deploy test
// Auto-deploy fix - 1790256378
// Deploy check 1790259112
