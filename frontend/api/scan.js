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

// Is this an RPC error that a retry might clear (load-balancer flakiness)?
function isTransientErr(msg) {
  return /invalid hex|http 403|http 50[234]|429|timeout|timed ?out|aborted|fetch failed|network|ECONN|rate ?limit|too many requests/i.test(msg);
}
// Is this the deterministic "range has >10k logs" cap?
function isCapErr(msg) {
  return /exceeds limit|limit of|10000|results cap/i.test(msg);
}

// Fetch transfer logs for a block range. The RHC RPC caps eth_getLogs at
// 10,000 logs per call; when a chunk exceeds that, recursively split it in
// half and merge, so no transfer window is silently dropped.
// The RHC RPC load-balances nodes and *intermittently* rejects wide ranges
// (403s, "invalid hex string"). Transient failures are retried with backoff,
// then SPLIT (smaller queries get through the load balancer) rather than
// silently dropping up to 20k blocks of data. `stats.failedChunks` records any
// range that still couldn't be read, so the caller can detect a total wipeout
// and fail honestly instead of returning a fake empty result.
async function fetchTransferLogs(token, transferTopic, fromBlock, toBlock, network, _depth = 0, stats = null) {
  if (fromBlock > toBlock) return [];
  const filter = {
    fromBlock: ethHex(fromBlock),
    toBlock: ethHex(toBlock),
    address: token,
    topics: [transferTopic]
  };
  let body = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      body = await rpcCallFull("eth_getLogs", [filter], network);
    } catch (e) {
      body = { error: { message: String(e.message || e) } };
    }
    if (!body || !body.error) return body?.result || [];
    const msg = String(body.error.message || body.error);
    // Deterministic errors (cap / pruned state) — stop retrying, handle below.
    if (isCapErr(msg) || !isTransientErr(msg)) break;
    // Transient node flakiness — back off and retry the same range.
    await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
  }
  if (body?.error) {
    const msg = String(body.error.message || body.error);
    if (isCapErr(msg) && _depth < 20 && fromBlock !== toBlock) {
      // 10k cap — split in half and merge.
      const mid = Math.floor((fromBlock + toBlock) / 2);
      const a = await fetchTransferLogs(token, transferTopic, fromBlock, mid, network, _depth + 1, stats);
      const b = await fetchTransferLogs(token, transferTopic, mid + 1, toBlock, network, _depth + 1, stats);
      return [...a, ...b];
    }
    if (isTransientErr(msg)) {
      // Node kept refusing this chunk. Smaller chunks get through the
      // load balancer — split (shallow cap keeps fan-out bounded) instead of
      // dropping the range. Children record their own leaf failures in stats.
      if (fromBlock !== toBlock && _depth < 3) {
        const mid = Math.floor((fromBlock + toBlock) / 2);
        const a = await fetchTransferLogs(token, transferTopic, fromBlock, mid, network, _depth + 1, stats);
        const b = await fetchTransferLogs(token, transferTopic, mid + 1, toBlock, network, _depth + 1, stats);
        return [...a, ...b];
      }
      // Leaf / too deep — record the gap so a total wipeout is detectable.
      if (stats) { stats.failedChunks += 1; stats.failedBlocks += toBlock - fromBlock + 1; }
      console.log(`getLogs transient fail [${fromBlock.toLocaleString()},${toBlock.toLocaleString()}] (depth ${_depth}): ${msg.slice(0, 120)}`);
      return [];
    }
    // Persistent deterministic error (pruned state etc.) — skip this chunk.
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
// eth_getLogs.
//
// The load-balanced RPC is FLAKY: it intermittently 403s / rejects wide
// ranges ("invalid hex string") and enforces a 10,000-log cap. Discovery must
// be robust to flakes. The invariant we protect: the returned block B is
// ALWAYS <= the true launch block (anchoring early is safe; skipping late is
// the bug that previously made it report 72M instead of 50.4M).
//
// 3-state probe:
//   - EMPTY        : range confirmed to have no Transfer logs
//   - NONEMPTY     : range confirmed to have Transfer logs. A 10k-log cap
//                      error is DEFINITIVELY nonempty (too many logs).
//   - UNDETERMINED : RPC flaked (or deadline hit); unknown. NEVER treated as
//                      empty. Coarse pass anchors at the first UNDET window
//                      instead of walking past it.
// Flow: 4M coarse walk -> anchor a window -> walk its 1M subs left-to-right ->
// bisect the anchor sub (cap = NONEMPTY, flake = keep-left, deadline =
// return anchor start). Deterministic ~25-35 probes in normal conditions.
async function findLaunchBlockByLogs(token, transferTopic, currentBlock, network, deadline = null) {
  console.log("Locating launch block (first Transfer event) via log-index scan...");
  if (deadline === null) deadline = Date.now() + 60000; // bounded: leave room for the scan

  const EMPTY = "empty", NONEMPTY = "nonempty", UNDET = "undetermined";
  // A 10k-log "exceeds limit / 10000 / too many" error PROVES the range is
  // busy — definitively NON-empty (we anchor here and scan forward).
  const isCapMsg = m => /exceeds|limit of|10000|results cap|too many (logs|results)/i.test(m);

  // Probe one range. Returns {state, logs}:
  //   EMPTY      -> logs=[] (confirmed no transfers)
  //   NONEMPTY   -> logs=actual logs, or null if it was a cap error
  //   UNDET      -> logs=null (RPC flaked or deadline hit; unknown)
  const probe = async (from, to) => {
    if (Date.now() > deadline) return { state: UNDET, logs: null };
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = await rpcCallFull("eth_getLogs", [{
        fromBlock: ethHex(from),
        toBlock: ethHex(to),
        address: token,
        topics: [transferTopic]
      }], network);
      if (!body || !body.error) {
        const logs = body?.result || [];
        return logs.length ? { state: NONEMPTY, logs } : { state: EMPTY, logs: [] };
      }
      const msg = String(body.error.message || body.error);
      if (isCapMsg(msg)) return { state: NONEMPTY, logs: null };
      // Transient flake (403 / "invalid hex string" / 429 / timeout) — back off.
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
    return { state: UNDET, logs: null };
  };

  // Find the exact first-transfer block inside [from,to] via binary search.
  // NONEMPTY -> tighten right; EMPTY -> tighten left; UNDET -> keep left
  // (earliest side, safe underestimate). Bounded steps + deadline cap.
  const firstTransferBlock = async (from, to) => {
    let lo = from, hi = to;
    for (let depth = 0; depth < 16 && lo < hi; depth++) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await probe(lo, mid);
      if (r.state === EMPTY) lo = mid + 1;      // left clean -> earliest is right
      else { hi = mid; }                          // NONEMPTY or UNDET -> keep left
    }
    const r = await probe(lo, hi);
    if (r.state === NONEMPTY && r.logs && r.logs.length) {
      r.logs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));
      return parseInt(r.logs[0].blockNumber, 16);
    }
    return lo; // flaked/deadline — safe underestimate (anchor early, scan forward)
  };

  // 1) Coarse pass: 4M windows from 0. Advance ONLY on a confirmed-empty
  //    window; the first non-empty OR undetermined window is the candidate.
  //    Inside the candidate, walk its 1M sub-windows left-to-right and bisect
  //    the first sub that is not confirmed empty.
  const COARSE = 4000000;
  outer:
  for (let s = 0; s <= currentBlock; s += COARSE) {
    const e = Math.min(s + COARSE - 1, currentBlock);
    const r = await probe(s, e);
    if (r.state === EMPTY) continue;            // confirmed clean, advance

    // Candidate 4M window (NONEMPTY, or UNDET which we never skip). Walk its
    // 1M sub-windows left-to-right; bisect the first sub that isn't confirmed
    // empty. If every sub is confirmed empty, the 4M window was a flake-UNDET
    // but is actually empty -> advance to the next 4M window (continue).
    for (let sub = s; sub <= e; sub += 1000000) {
      const subEnd = Math.min(sub + 999999, e);
      const sr = await probe(sub, subEnd);
      if (sr.state === EMPTY) continue;         // sub clean, next sub
      // Nonempty (cap proves it) or undetermined (safe-early) sub holds it.
      const launch = await firstTransferBlock(sub, subEnd);
      console.log(`Launch block found: ${launch.toLocaleString()}`);
      return launch;
    }
    continue; // all sub-windows confirmed empty -> next 4M window
  }

  if (Date.now() > deadline) {
    console.log("Discovery deadline hit; token may exist but launch block is unknown");
    return 0;
  }
  console.log("No Transfer logs found anywhere; token may not exist on this network");
  return 0;
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

    // One shared budget for discovery + scan, 10s under the 180s Vercel cap so
    // the function always answers (partial result beats a platform timeout).
    const overallDeadline = Date.now() + 170000;
    
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
        // Discovery gets its own sub-budget (90s) so the scan always keeps a
        // meaningful share of the overall deadline.
        startBlock = await findLaunchBlockByLogs(TOKEN, TRANSFER_TOPIC, currentBlock, network, Math.min(overallDeadline, Date.now() + 90000));
        if (!startBlock) {
          // Discovery failed (RPC flake storm or deadline) — NEVER scan from
          // block 0: that wastes the whole function on 200K empty blocks and
          // shows "no result". Fall back to a recent window like testnet.
          startBlock = Math.max(0, currentBlock - MAX_SCAN_BLOCKS);
          console.log(`Discovery failed; falling back to recent window (last ${MAX_SCAN_BLOCKS.toLocaleString()} blocks)`);
        }
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
    const seedStats = { failedChunks: 0, failedBlocks: 0 };
    let seedWallet = null;
    try {
      const seedLogs = await fetchTransferLogs(TOKEN, TRANSFER_TOPIC, startBlock, startBlock + 500, network, 0, seedStats);
      if (seedStats.failedChunks) {
        console.log(`Seed detection hit ${seedStats.failedChunks} transient RPC failure(s); seed may be mis-detected`);
      }
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
    // Track transient-RPC gaps so a total wipeout can't masquerade as a
    // genuine "zero transfers" result.
    const scanStats = { failedChunks: 0, failedBlocks: 0 };
    // Deadline for the transfer scan itself — shared across the whole function
    // (discovery + scan) so the two never add up past the 180s Vercel cap.
    const deadline = overallDeadline;

    for (let start = startBlock; start <= scanEnd; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, scanEnd);

      if (Date.now() > deadline) {
        console.log(`Scan deadline reached at block ${start.toLocaleString()}; returning partial result`);
        break;
      }

      // Progress every 50K blocks (scan window is bounded to 200K)
      if ((start - startBlock) % 50000 === 0 && start > startBlock) {
        const progress = ((start - startBlock) / (scanEnd - startBlock) * 100).toFixed(0);
        console.log(`  Progress: ${progress}% (${logCount} logs)`);
      }

      const logs = await fetchTransferLogs(TOKEN, TRANSFER_TOPIC, start, end, network, 0, scanStats);

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

    // Honest failure: if the RPC 403-stormed the scan and we lost data, say so
    // instead of returning a plausible-looking empty result.
    if (scanStats.failedChunks > 0 && logCount === 0) {
      console.error(`Scan lost ${scanStats.failedChunks} chunk(s) (${scanStats.failedBlocks} blocks) to transient RPC errors; failing honestly`);
      return res.status(503).json({
        error: "The chain RPC is flaky right now — the scan lost data. Please retry in a minute.",
        transient: true,
        token: address,
        network
      });
    }

    const partial = Date.now() > deadline;
    console.log(`\nScan complete: ${logCount} transfers from ${Object.keys(allBuyers).length} unique wallets${partial ? " (PARTIAL — deadline)" : ""}${scanStats.failedChunks ? ` (${scanStats.failedChunks} chunk(s) lost)` : ""}`);
    
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
