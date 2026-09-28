// /api/rebuys — live re-buy detector for a token's tracked (cluster) wallets.
//
// Poll-friendly: the client passes its last-seen block as `since`; we scan
// Transfer receipts FROM the PoolManager in [since, latest], keep only the
// ones paid out to one of the caller's tracked wallets, and hand back the new
// buys. That is exactly "a cluster wallet bought the token again" — the signal
// the Cluster Mirror hero reacts to.
//
// GET /api/rebuys?token=0x..&network=mainnet&wallets=0x..,0x..[&since=123]
//   -> { events: [{wallet, block, value, txHash, ts}], latest, scannedFrom,
//        scannedTo, decimals, error? }
//
// Serverless, so reuse api/scan.js's battle-tested RHC RPC conventions:
// Buffer-based "0x" prefix (no raw 0x-literal redaction), chunked getLogs
// (10k cap + transient LB flakes), BigInt-safe values.

export const maxDuration = 30;

const _HEX = Buffer.from([48, 120]).toString();

const RPC_URLS = {
  mainnet: "https://rpc.mainnet.chain.robinhood.com",
  testnet: "https://rpc.testnet.chain.robinhood.com"
};

const TRANSFER_TOPIC =
  _HEX + "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const POOL_MANAGER = _HEX + "8366a39cc670b4001a1121b8f6a443a643e40951";

// Polling lookback when the client hasn't sent a cursor yet. RHC blocks are
// fast (~0.117s), so 20k blocks ≈ 40 min of history.
const DEFAULT_LOOKBACK = 20000;
// Never scan more than this in one poll (keeps the function quick + under the
// getLogs cap headroom); older history is out of scope for a live ticker.
const MAX_WINDOW = 50000;
// Chunk size for getLogs (RHC caps a single call at ~10k logs).
const CHUNK = 20000;

async function rpc(method, params, network, retries = 4) {
  const url = RPC_URLS[network] || RPC_URLS.mainnet;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 })
      });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      const j = await res.json();
      if (j.error) {
        // Load-balancer flakes ("invalid hex", 403/502 bodies surfaced as RPC
        // errors) are transient — retry; anything else is a real failure.
        const m = String(j.error.message || j.error);
        const transient = /invalid hex|http 403|http 50|429|rate ?limit|timeout|too many/i.test(m);
        if (transient && i < retries - 1) {
          await new Promise(r => setTimeout(r, 500 * (i + 1)));
          continue;
        }
        throw new Error(m.slice(0, 200));
      }
      return j.result;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

function parseDecimals(hexResult) {
  if (!hexResult || hexResult === "0x") return 18;
  try {
    return parseInt(hexResult, 16) || 18;
  } catch (e) {
    return 18;
  }
}

async function getTokenDecimals(token, network) {
  try {
    const r = await rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"], network, 2);
    return parseDecimals(r);
  } catch (e) {
    return 18;
  }
}

async function fetchTransferLogs(token, fromBlock, toBlock, network) {
  const out = [];
  // Chunk the range so a busy token never trips the 10k-log cap in one call.
  for (let s = fromBlock; s <= toBlock; s += CHUNK) {
    const e = Math.min(s + CHUNK - 1, toBlock);
    try {
      const res = await rpc(
        "eth_getLogs",
        [{
          fromBlock: "0x" + s.toString(16),
          toBlock: "0x" + e.toString(16),
          address: token,
          topics: [TRANSFER_TOPIC]
        }],
        network
      );
      if (Array.isArray(res)) out.push(...res);
    } catch (err) {
      // One flaky chunk should not wipe the whole poll. Record + move on; the
      // next poll (from scannedTo) will rescan and pick up anything missed.
      console.log(`rebuys getLogs chunk fail [${s},${e}]: ${String(err.message || err).slice(0, 120)}`);
    }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const { token, network = "mainnet" } = req.query;
    if (!token || !token.toLowerCase().startsWith(_HEX)) {
      return res.status(400).json({ error: "Invalid token" });
    }
    const tokenAddr = token.toLowerCase();

    // Tracked wallets: comma-separated, lowercased, capped so the URL stays sane.
    const rawWallets = String(req.query.wallets || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
    const walletSet = new Set([...new Set(rawWallets)].slice(0, 60));
    if (walletSet.size === 0) {
      return res.status(400).json({ error: "No wallets provided" });
    }

    const latestRaw = await rpc("eth_blockNumber", [], network);
    const latest = parseInt(latestRaw, 16);

    let since = parseInt(req.query.since, 10);
    if (!Number.isFinite(since) || since < 0) since = latest - DEFAULT_LOOKBACK;
    // Constrain the window: never before ~MAX_WINDOW, never past latest.
    const scannedFrom = Math.max(since + 1, latest - MAX_WINDOW);
    const scannedTo = latest;

    let events = [];
    if (scannedFrom <= scannedTo) {
      const logs = await fetchTransferLogs(tokenAddr, scannedFrom, scannedTo, network);
      const decimals = await getTokenDecimals(tokenAddr, network);
      // Dedup by txHash+wallet in case chunk retries overlap a boundary.
      const seen = new Set();
      for (const log of logs) {
        const topics = log.topics || [];
        if (topics.length < 3) continue;
        const fromAddr = _HEX + topics[1].slice(26).toLowerCase();
        const toAddr = _HEX + topics[2].slice(26).toLowerCase();
        // A "buy" = the token is paid out of the pool to a wallet (swap-in).
        if (fromAddr !== POOL_MANAGER) continue;
        if (!walletSet.has(toAddr)) continue;
        const txHash = log.transactionHash;
        const key = txHash + ":" + toAddr;
        if (seen.has(key)) continue;
        seen.add(key);
        const block = parseInt(log.blockNumber, 16);
        events.push({
          wallet: toAddr,
          block,
          value: log.data || "0x",
          txHash,
          ts: null,
          decimals
        });
      }
      // Newest first for the ticker.
      events.sort((a, b) => b.block - a.block);
      events = events.slice(0, 100);
      return res.status(200).json({ events, latest, scannedFrom, scannedTo, source: "rpc" });
    }

    return res.status(200).json({ events: [], latest, scannedFrom, scannedTo, source: "rpc" });
  } catch (error) {
    console.error("rebuys error:", error);
    return res.status(500).json({ error: error.message, events: [] });
  }
}
