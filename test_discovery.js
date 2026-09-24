// Token creation block discovery using Explorer API + RPC binary search
const ethHex = (val) => {
  const hex = BigInt(val).toString(16);
  return '0x' + hex.padStart(Math.ceil(hex.length / 2) * 2, '0');
};

async function rpcCall(method, params, network) {
  const rpcUrl = network === 'testnet' 
    ? 'https://rpc.testnet.chain.robinhood.com'
    : 'https://rpc.mainnet.chain.robinhood.com';
  
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await resp.json();
  return data.result;
}

async function getExplorerTxData(tokenAddress, network) {
  // Use explorer to get first and last transactions
  const base = network === 'testnet' 
    ? 'https://explorer.testnet.chain.robinhood.com/api/v2'
    : 'https://explorer.mainnet.chain.robinhood.com/api/v2';
  
  // Get first 20 transactions (oldest first by default)
  const txResp = await fetch(`${base}/addresses/${tokenAddress}/transactions`);
  const txData = await txResp.json();
  
  // Get first 20 token transfers
  const transferResp = await fetch(`${base}/addresses/${tokenAddress}/token-transfers`);
  const transferData = await transferResp.json();
  
  return { txData, transferData };
}

async function findCreationBlockFromTransfers(transfers, startBlock, endBlock) {
  if (!transfers.items || transfers.items.length === 0) {
    return null;
  }
  
  // Sort by block number
  const sorted = [...transfers.items].sort((a, b) => a.block_number - b.block_number);
  const oldestBlock = sorted[0].block_number;
  
  console.log(`Oldest transfer at block ${oldestBlock}`);
  
  // Binary search for contract creation
  let low = Math.max(0, oldestBlock - 1000);
  let high = oldestBlock;
  let creationBlock = oldestBlock;
  
  while (low <= high && high - low < 10000) {
    const mid = Math.floor((low + high) / 2);
    const code = await rpcCall('eth_getCode', ['0x44DB91782775b07a9daeab4c4d796475f8b3a7', ethHex(mid)], 'testnet');
    
    if (code && code !== '0x' && code.length > 2) {
      creationBlock = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  
  return creationBlock;
}

async function discoverToken(tokenAddress, network) {
  console.log(`\n=== Discovering ${tokenAddress} (${network}) ===`);
  
  // Get metadata from explorer
  const metaResp = await fetch(`https://explorer.${network}.chain.robinhood.com/api/v2/addresses/${tokenAddress}`);
  const metaData = await metaResp.json();
  console.log(`Token: ${metaData.name} (${metaData.symbol})`);
  console.log(`Total holders: ${metaData.token_holders_count}`);
  
  // Get transactions and transfers from explorer
  const { txData, transferData } = await getExplorerTxData(tokenAddress, network);
  
  if (transferData.items && transferData.items.length > 0) {
    console.log(`Explorer found ${transferData.items.length} token transfers`);
    console.log(`First block: ${transferData.items[0].block_number}`);
    console.log(`Last block: ${transferData.items[transferData.items.length - 1].block_number}`);
    
    // Use explorer's first block as scan start
    const startBlock = Math.max(0, transferData.items[0].block_number - 100);
    const endBlock = transferData.items[transferData.items.length - 1].block_number + 1000;
    
    console.log(`Recommended scan range: ${startBlock} to ${endBlock}`);
    console.log(`Range size: ${(endBlock - startBlock).toLocaleString()} blocks`);
    
    return {
      startBlock,
      endBlock,
      totalTransfers: transferData.items.length,
      metadata: metaData
    };
  } else {
    console.log('No transfers found in explorer, falling back to RPC scan');
    return null;
  }
}

async function testAll() {
  // Test tokens
  const tokens = [
    { address: '0x44DB91782775b07A9DAEABaB4C4D796475F8B3A7', network: 'testnet' },
    { address: '0x829E331438f3F7401d3DF427FA2C7610f2482970', network: 'testnet' },
    { address: '0xF6e63DB21Ae8D780B26000d2CBE20802E07a0987', network: 'mainnet' }
  ];
  
  for (const token of tokens) {
    const result = await discoverToken(token.address, token.network);
    console.log(`Result:`, result);
    console.log('---');
  }
}

testAll().catch(console.error);
