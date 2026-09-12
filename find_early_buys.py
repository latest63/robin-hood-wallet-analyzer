#!/usr/bin/env python3
"""Find early buy transactions for specific wallets on Robinhood Chain Mainnet"""
import json
import urllib.request
import ssl

RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
TOKEN_CONTRACT="0x385f4f8ae47651ce5f58f5265395a669f8281e18"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
DEPLOY_BLOCK = 53946846

WALLETS = [
    "0x24d655a4ed48bfd4291de041a1f81a11ca456aa6",
    "0xcc941b23420b1a402e8972b5b3fc329de9ac19df",
    "0x92d435c96e63c43e12d6d0ab28f6b0b04072f765",
    "0x4d192365c30928533577a023b05663e5f48b3025",
    "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
]

def rpc_call(method, params):
    payload = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(RPC_URL, data=data, headers={'Content-Type': 'application/json'})
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            result = json.loads(resp.read().decode())
            return result.get('result')
    except Exception as e:
        return None

def find_early_buys(wallet, start_block, end_block):
    earliest_buy = None
    
    chunk_size = 500
    for block_start in range(start_block, end_block + 1, chunk_size):
        block_end = min(block_start + chunk_size - 1, end_block)
        
        logs = rpc_call("eth_getLogs", [{
            "fromBlock": hex(block_start),
            "toBlock": hex(block_end),
            "address": TOKEN_CONTRACT,
            "topics": [TRANSFER_TOPIC]
        }])
        
        if not logs:
            continue
        
        for log in logs:
            topics = log.get('topics', [])
            if len(topics) < 3:
                continue
            
            from_addr = '0x' + topics[1][26:].lower()
            to_addr = '0x' + topics[2][26:].lower()
            
            if to_addr == wallet.lower():
                amount = int(log.get('data', '0x0'), 16) / 1e18
                tx_hash = log['transactionHash']
                block_num = int(log['blockNumber'], 16)
                
                receipt = rpc_call("eth_getTransactionReceipt", [tx_hash])
                eth_spent = 0
                if receipt:
                    eth_spent = int(receipt.get('value', '0x0'), 16) / 1e18
                
                if earliest_buy is None or block_num < earliest_buy['block']:
                    earliest_buy = {
                        'wallet': wallet,
                        'tx_hash': tx_hash,
                        'block': block_num,
                        'amount': amount,
                        'eth_spent': eth_spent
                    }
        
        if earliest_buy and earliest_buy['block'] <= start_block + 50:
            break
    
    return earliest_buy

print("=" * 100)
print("EARLY BUY TRANSACTION FINDER")
print(f"Token: {TOKEN_CONTRACT}")
print(f"Network: Robin Hood Chain MAINNET")
print(f"Deploy Block: {DEPLOY_BLOCK}")
print("=" * 100)

results = []
for i, wallet in enumerate(WALLETS):
    print(f"\n[{i+1}/{len(WALLETS)}] Searching for {wallet[:20]}...")
    
    buy_tx = find_early_buys(wallet, DEPLOY_BLOCK, DEPLOY_BLOCK + 1000)
    
    if buy_tx:
        print(f"  FOUND!")
        print(f"     TX Hash: {buy_tx['tx_hash']}")
        print(f"     Block: {buy_tx['block']}")
        print(f"     Amount: {buy_tx['amount']:,.2f} tokens")
        results.append(buy_tx)
    else:
        print(f"  Not found in first 1000 blocks")

print("\n\n" + "=" * 100)
print("SUMMARY")
print("=" * 100)

if results:
    print(f"\nFound {len(results)} early buy transactions:\n")
    print(f"{'Wallet':<50} {'TX Hash':<45} {'Block':>10} {'Amount':>15}")
    print("-" * 120)
    for r in results:
        print(f"{r['wallet']:<50} {r['tx_hash']:<45} {r['block']:>10} {r['amount']:>15,.2f}")
else:
    print("\nNo buy transactions found.")

with open("/home/ubuntu/.hermes/scripts/cluster-signal/early_buy_txs.json", 'w') as f:
    json.dump(results, f, indent=2)
print(f"\nResults saved to: early_buy_txs.json")
