#!/usr/bin/env python3
"""Extended wallet activity finder"""
import json
import urllib.request
import ssl

RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
TOKEN_CONTRACT="0x385f4f8ae47651ce5f58f5265395a669f8281e18"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

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
    except:
        return None

# Get current block
latest_hex = rpc_call("eth_blockNumber", [])
latest = int(latest_hex, 16) if latest_hex else 0
print(f"Current block: {latest:,}")
print(f"Searching from block 53,946,846 to {latest:,}\n")

all_results = {}

for wallet in WALLETS:
    print(f"\n{'='*80}")
    print(f"Wallet: {wallet}")
    print(f"{'='*80}")
    
    # Get nonce
    nonce_hex = rpc_call("eth_getTransactionCount", [wallet, "latest"])
    nonce = int(nonce_hex, 16) if nonce_hex else 0
    print(f"Total transactions: {nonce}")
    
    # Search for transfers involving this wallet
    transfers = []
    chunk_size = 2000
    
    start_block = 53946846
    end_search = min(start_block + 50000, latest)
    
    for block_start in range(start_block, end_search, chunk_size):
        block_end = min(block_start + chunk_size - 1, end_search)
        
        # Search where wallet is receiver (topic[2])
        logs = rpc_call("eth_getLogs", [{
            "fromBlock": hex(block_start),
            "toBlock": hex(block_end),
            "address": TOKEN_CONTRACT,
            "topics": [
                TRANSFER_TOPIC,
                None,
                f"0x000000000000000000000000{wallet[2:].lower()}"
            ]
        }])
        
        if logs:
            for log in logs:
                topics = log.get('topics', [])
                amount = int(log.get('data', '0x0'), 16) / 1e18
                tx_hash = log['transactionHash']
                block_num = int(log['blockNumber'], 16)
                from_addr = '0x' + topics[1][26:].lower() if len(topics) > 1 else 'unknown'
                
                transfers.append({
                    'block': block_num,
                    'tx': tx_hash,
                    'amount': amount,
                    'from': from_addr,
                    'direction': 'RECEIVED'
                })
        
        # Search where wallet is sender (topic[1])
        logs2 = rpc_call("eth_getLogs", [{
            "fromBlock": hex(block_start),
            "toBlock": hex(block_end),
            "address": TOKEN_CONTRACT,
            "topics": [
                TRANSFER_TOPIC,
                f"0x000000000000000000000000{wallet[2:].lower()}",
                None
            ]
        }])
        
        if logs2:
            for log in logs2:
                topics = log.get('topics', [])
                amount = int(log.get('data', '0x0'), 16) / 1e18
                tx_hash = log['transactionHash']
                block_num = int(log['blockNumber'], 16)
                to_addr = '0x' + topics[2][26:].lower() if len(topics) > 2 else 'unknown'
                
                # Avoid duplicates
                already_has = any(t['tx'] == tx_hash for t in transfers)
                if not already_has:
                    transfers.append({
                        'block': block_num,
                        'tx': tx_hash,
                        'amount': amount,
                        'to': to_addr,
                        'direction': 'SENT'
                    })
        
        if (block_start - start_block) % 10000 == 0 and block_start > start_block:
            print(f"  Scanned to block {block_end:,}... ({len(transfers)} transfers so far)")
    
    # Sort by block
    transfers.sort(key=lambda x: x['block'])
    
    print(f"\nTotal token transfers found: {len(transfers)}")
    
    if transfers:
        print("\nFirst 10 transfers:")
        for t in transfers[:10]:
            print(f"  Block {t['block']}: {t['direction']} {t['amount']:,.2f} tokens | TX: {t['tx'][:20]}...")
        
        # Calculate totals
        total_received = sum(t['amount'] for t in transfers if t['direction'] == 'RECEIVED')
        total_sent = sum(t['amount'] for t in transfers if t['direction'] == 'SENT')
        net = total_received - total_sent
        
        print(f"\nSummary:")
        print(f"  Total Received: {total_received:,.2f}")
        print(f"  Total Sent: {total_sent:,.2f}")
        print(f"  Net Position: {net:,.2f}")
        
        # Find first buy
        first_buy = next((t for t in transfers if t['direction'] == 'RECEIVED'), None)
        if first_buy:
            print(f"\n  FIRST BUY:")
            print(f"    TX Hash: {first_buy['tx']}")
            print(f"    Block: {first_buy['block']}")
            print(f"    Amount: {first_buy['amount']:,.2f} tokens")
    
    all_results[wallet] = {
        'nonce': nonce,
        'transfers': transfers,
        'total_received': total_received,
        'total_sent': total_sent,
        'net_position': net
    }

# Save all results
with open("/home/ubuntu/.hermes/scripts/cluster-signal/wallet_transfer_analysis.json", 'w') as f:
    json.dump(all_results, f, indent=2)
print(f"\n\nAll results saved to: wallet_transfer_analysis.json")