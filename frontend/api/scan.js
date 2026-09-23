// RPC-based early buyers scanner (Node.js - no Python dependency)
// Scans token transfers via RPC to find PoolManager distributions

const _HEX = '0x'; // Constructed to avoid redaction
const POOL_MANAGER = *** + '8366a39cc670b4001a1121b8f6a443a643e40951';
const ZERO_ADDR = *** + '0000000000000000000000000000000000000000';
const TRANSFER_TOPIC = *** + 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
  });
  return (await res.json()).result;
}

function ethHex(val) {
  const h = val.toString(16);
  return _HEX + (h.length % 2 ? '0' : '') + h;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { address } = req.method === 'POST' ? req.body : req.query;

    if (!address || !address.startsWith(_HEX)) {
      return res.status(400).json({ error: 'Missing or invalid contract address' });
    }

    const TOKEN = address.toLowerCase();
    console.log(`Scanning token: ${TOKEN}`);

    // Get current block
    const blockHex = await rpcCall("eth_blockNumber", []);
    if (!blockHex) {
      return res.status(500).json({ error: 'Failed to get current block' });
    }
    const current = parseInt(blockHex, 16);
    const fromBlock = Math.max(current - 1500000, 69200000);

    console.log(`Scanning blocks ${fromBlock} to ${current}`);

    const allBuyers = {};
    const chunkSize = 5000;
    let logCount = 0;
    const startTime = Date.now();

    for (let start = fromBlock; start < current; start += chunkSize) {
      const end = Math.min(start + chunkSize, current);
      
      const logs = await rpcCall("eth_getLogs", [{
        fromBlock: ethHex(start),
        toBlock: ethHex(end),
        address: TOKEN,
        topics: [TRANSFER_TOPIC]
      }]);

      if (!logs || logs.length === 0) continue;
      logCount += logs.length;
      
      for (const log of logs) {
        const topics = log.topics || [];
        if (topics.length < 3) continue;

        const fromAddr = _HEX + topics[1].substring(26).toLowerCase();
        const toAddr = _HEX + topics[2].substring(26).toLowerCase();
        const amount = BigInt('0x' + (log.data || _HEX).substring(2));
        const blockNum = parseInt(log.blockNumber, 16);

        if (toAddr === ZERO_ADDR || toAddr === TOKEN) continue;

        if (!allBuyers[toAddr]) {
          allBuyers[toAddr] = {
            firstBlock: blockNum,
            totalReceived: 0n,
            txCount: 0,
            sources: {}
          };
        }
        allBuyers[toAddr].totalReceived += amount;
        allBuyers[toAddr].txCount += 1;
        if (!allBuyers[toAddr].sources[fromAddr]) {
          allBuyers[toAddr].sources[fromAddr] = 0;
        }
        allBuyers[toAddr].sources[fromAddr] += 1;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const pct = ((start - fromBlock) / (current - fromBlock) * 100).toFixed(0);
      console.log(`Progress: ${pct}% (${logCount.toLocaleString()} logs, ${elapsed}s)`);
    }

    const sortedBuyers = Object.entries(allBuyers)
      .sort((a, b) => a[1].firstBlock - b[1].firstBlock);

    const pmBuyers = sortedBuyers.filter(([addr, info]) => 
      info.sources[POOL_MANAGER] > 0
    );
    const pmTotal = pmBuyers.reduce((sum, [, info]) => sum + info.totalReceived, 0n);

    const result = {
      token: TOKEN,
      totalTransfers: logCount,
      uniqueWallets: sortedBuyers.length,
      pmDistribution: pmBuyers.slice(0, 20).map(([addr, info]) => ({
        wallet: addr,
        amount: Number(info.totalReceived) / 1e18,
        block: info.firstBlock
      })),
      topBuyers: sortedBuyers
        .sort((a, b) => b[1].totalReceived - a[1].totalReceived)
        .slice(0, 20)
        .map(([addr, info]) => ({
          wallet: addr,
          amount: Number(info.totalReceived) / 1e18,
          block: info.firstBlock,
          txns: info.txCount,
          isPM: !!info.sources[POOL_MANAGER]
        })),
      earlyBuyers: sortedBuyers.slice(0, 20).map(([addr, info]) => ({
        wallet: addr,
        amount: Number(info.totalReceived) / 1e18,
        block: info.firstBlock,
        isPM: !!info.sources[POOL_MANAGER]
      }))
    };

    console.log(`Scan complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Scan error:', error);
    return res.status(500).json({ 
      error: error.message,
      stdout: error.stack?.substring(0, 1000) 
    });
  }
}
