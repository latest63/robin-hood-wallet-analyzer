// RPC-based early buyers scanner (Node.js - no Python dependency)
const _HEX = Buffer.from([48, 120]).toString();

async function rpcCall(method, params) {
  const res = await fetch('https://rpc.mainnet.chain.robinhood.com', {
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

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { address } = req.method === 'POST' ? req.body : req.query;
    if (!address?.startsWith(_HEX)) {
      return res.status(400).json({ error: 'Missing or invalid contract address' });
    }

    const TOKEN=addres...toLowerCase();
    console.log(`Scanning token: ${TOKEN}`);

    const blockHex = await rpcCall("eth_blockNumber", []);
    const current = parseInt(blockHex, 16);
    const fromBlock = Math.max(current - 1500000, 69200000);

    const allBuyers = {};
    let logCount = 0;
    const startTime = Date.now();

    for (let start = fromBlock; start < current; start += 5000) {
      const logs = await rpcCall("eth_getLogs", [{
        fromBlock: ethHex(start),
        toBlock: ethHex(Math.min(start + 5000, current)),
        address: TOKEN,
        topics: [_HEX + "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
      }]);
      
      if (!logs?.length) continue;
      logCount += logs.length;
      
      for (const log of logs) {
        const toAddr = _HEX + log.topics[2].substring(26).toLowerCase();
        const fromAddr = _HEX + log.topics[1].substring(26).toLowerCase();
        const amount = BigInt('0x' + (log.data || _HEX).substring(2));
        const blockNum = parseInt(log.blockNumber, 16);
        
        if (!allBuyers[toAddr]) {
          allBuyers[toAddr] = { totalReceived: 0n, firstBlock: blockNum, txCount: 0, sources: {} };
        }
        allBuyers[toAddr].totalReceived += amount;
        allBuyers[toAddr].txCount++;
        allBuyers[toAddr].sources[fromAddr] = (allBuyers[toAddr].sources[fromAddr] || 0) + 1;
      }
      
      const pct = ((start - fromBlock) / (current - fromBlock) * 100).toFixed(0);
      process.stdout.write('\rProgress: ' + pct + '% (' + logCount + ' logs)');
    }

    console.log('\nScan complete in ' + ((Date.now() - startTime) / 1000).toFixed(1) + 's');

    const sorted = Object.entries(allBuyers).sort((a, b) => a[1].firstBlock - b[1].firstBlock);
    
    return res.status(200).json({
      token: TOKEN,
      totalTransfers: logCount,
      uniqueWallets: sorted.length,
      buyers: sorted.slice(0, 20).map(([addr, info]) => ({
        wallet: addr,
        amount: Number(info.totalReceived) / 1e18,
        block: info.firstBlock,
        txns: info.txCount
      }))
    });
  } catch (error) {
    console.error('Scan error:', error);
    return res.status(500).json({ error: error.message });
  }
}
