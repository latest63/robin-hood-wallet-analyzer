#!/usr/bin/env python3
"""Find token transfers for wallets on Robin Hood Chain Mainnet"""
import json
import urllib.request
import ssl

RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
TOKEN_CONTRACT = "0x385f4f8ae47651ce5f58f5265395a669f8281e18"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

WALLETS = [
    "0x24d655a4ed48bfd4291de041a1f81a11ca456aa6",
    "0xcc941b23420b1a402e8972b5b3fc329de9ac19df",
    "0x92d435c96e63c43e12d6d0ab28f6b0b04072f765",
    "0x4d192365c30928533577a023b05663e5f48b3025",
    "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
]

DEPLOY_BLOCK = 53946846

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

def scan_transfers(wallet, start_block, end_block):
    """Scan blocks for token transfers involving wallet"""
    transfers = []
    
    for block_start in range(start_block, end_block + 1, 500):
        block_end = min(block_start + 499, end_block)
        
        # Get logs where wallet received tokens
        logs = rpc_call("eth_getLogs", [{
            "fromBlock": hex(block_start),
            "toBlock": hex(block_end),
            "address": TOKEN_CONTRACT,
            "topics": [
                TRANSFER_TOPIC,
                None,
                "0x" + wallet[2:].lower()
            ]
        }])
        
        if logs:
            for log in logs:
                amount = int(log.get('data', '0x0'), 16) / 1e18
                from_addr = '0x' + log['topics'][1][26:].lower()
                transfers.append({
                    'block': int(log['blockNumber'], 16),
                    'tx': log['transactionHash'],
                    'amount': amount,
                    'from': from_addr,
                    'direction': 'RECEIVED'
                })
        
        # Get logs where wallet sent tokens
        logs2 = rpc_call("eth_getLogs", [{
            "fromBlock": hex(block_start),
            "toBlock": hex(block_end),
            "address": TOKEN_CONTRACT,
            "topics": [
                TRANSFER_TOPIC,
                "0x" + wallet[2:].lower(),
                None
            ]
        }])
        
        if logs2:
            for log in logs2:
                amount = int(log.get('data', '0x0'), 16) / 1e18
                to_addr = '0x' + log['topics'][2][26:].lower()
                tx_hash = log['transactionHash']
                
                # Avoid duplicates
                if not any(t['tx'] == tx_hash for t in transfers):
                    transfers.append({
                        'block': int(log['blockNumber'], 16),
                        'tx': tx_hash,
                        'amount': amount,
                        'to': to_addr,
                        'direction': 'SENT'
                    })
        
        # Rate limit
        import time
        time.sleep(0.1)
    
    return transfers

def main():
    print("=" * 100)
    print("WALLET TRANSFER ANALYZER - MAINNET")
    print(f"Token: {TOKEN_CONTRACT}")
    print(f"Deploy Block: {DEPLOY_BLOCK}")
    print("=" * 100)
    
    # Get current block
    latest_hex = rpc_call("eth_blockNumber", [])
    latest = int(latest_hex, 16) if latest_hex else 0
    print(f"Current Block: {latest:,}\n")
    
    all_results = {}
    
    for wallet in WALLETS:
        print(f"\n{'='*80}")
        print(f"Wallet: {wallet}")
        print(f"{'='*80}")
        
        # Basic info
        nonce = rpc_call("eth_getTransactionCount", [wallet, "latest"])
        balance = rpc_call("eth_getBalance", [wallet, "latest"])
        
        tx_count = int(nonce, 16) if nonce else 0
        eth_balance = int(balance, 16) / 1e18 if balance else 0
        
        print(f"Total TXs: {tx_count}")
        print(f"ETH Balance: {eth_balance:.6f}")
        
        # Scan transfers
        end_block = min(DEPLOY_BLOCK + 50000, latest)
        transfers = scan_transfers(wallet, DEPLOY_BLOCK, end_block)
        transfers.sort(key=lambda x: x['block'])
        
        print(f"Token Transfers: {len(transfers)}")
        
        if transfers:
            total_received = sum(t['amount'] for t in transfers if t['direction'] == 'RECEIVED')
            total_sent = sum(t['amount'] for t in transfers if t['direction'] == 'SENT')
            net = total_received - total_sent
            
            print(f"\nFirst 10 transfers:")
            for t in transfers[:10]:
                print(f"  Block {t['block']}: {t['direction']} {t['amount']:,.2f} | TX: {t['tx'][:20]}...")
            
            print(f"\nTotals:")
            print(f"  Received: {total_received:,.2f}")
            print(f"  Sent: {total_sent:,.2f}")
            print(f"  Net: {net:,.2f}")
            
            first_buy = next((t for t in transfers if t['direction'] == 'RECEIVED'), None)
            if first_buy:
                print(f"\nFIRST BUY:")
                print(f"  TX: {first_buy['tx']}")
                print(f"  Block: {first_buy['block']}")
                print(f"  Amount: {first_buy['amount']:,.2f}")
                print(f"  From: {first_buy.get('from', 'unknown')}")
        
        all_results[wallet] = {
            'transfers': transfers,
            'tx_count': tx_count,
            'eth_balance': eth_balance
        }
    
    # Summary
    print("\n\n" + "=" * 100)
    print("SUMMARY")
    print("=" * 100)
    
    for wallet, data in all_results.items():
        transfers = data['transfers']
        if transfers:
            received = sum(t['amount'] for t in transfers if t['direction'] == 'RECEIVED')
            sent = sum(t['amount'] for t in transfers if t['direction'] == 'SENT')
            print(f"\n{wallet}")
            print(f"  Net Position: {received - sent:,.2f} tokens")
            if received > 0:
                print(f"  First Buy TX: {transfers[0]['tx'][:20]}...")
        else:
            print(f"\n{wallet}: No token activity found")
    
    # Save
    with open("/home/ubuntu/.hermes/scripts/cluster-signal/wallet_analysis.json", 'w') as f:
        json.dump(all_results, f, indent=2)
    print(f"\nSaved to: wallet_analysis.json")

if __name__ == "__main__":
    main()