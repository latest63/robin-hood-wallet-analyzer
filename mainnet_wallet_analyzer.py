#!/usr/bin/env python3
"""Mainnet Wallet Analyzer"""
import json
import urllib.request
import ssl
import time

RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
TOKEN_CONTRACT="0x385f4f8ae47651ce5f58f5265395a669f8281e18"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

TARGET_WALLETS = [
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
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                result = json.loads(resp.read().decode())
                return result.get('result')
        except Exception as e:
            if attempt == 2:
                return None
            time.sleep(1)
    return None

def main():
    print("=" * 100)
    print("MAINNET WALLET ANALYZER")
    print(f"Token: {TOKEN_CONTRACT}")
    print("=" * 100)
    
    latest_hex = rpc_call("eth_blockNumber", [])
    latest_block = int(latest_hex, 16) if latest_hex else 0
    print(f"Current Block: {latest_block:,}\n")
    
    results = []
    
    for wallet in TARGET_WALLETS:
        print(f"\nAnalyzing {wallet}...")
        
        nonce = rpc_call("eth_getTransactionCount", [wallet, "latest"])
        balance = rpc_call("eth_getBalance", [wallet, "latest"])
        code = rpc_call("eth_getCode", [wallet, "latest"])
        
        tx_count = int(nonce, 16) if nonce else 0
        eth_balance = int(balance, 16) / 1e18 if balance else 0
        is_contract = bool(code and code != "0x")
        
        print(f"  TX Count: {tx_count} | ETH: {eth_balance:.6f} | Contract: {is_contract}")
        
        transfers = []
        scan_range = min(DEPLOY_BLOCK + 10000, latest_block)
        
        for block_start in range(DEPLOY_BLOCK, scan_range, 500):
            block_end = min(block_start + 500, scan_range)
            
            logs = rpc_call("eth_getLogs", [{
                "fromBlock": hex(block_start),
                "toBlock": hex(block_end),
                "address": TOKEN_CONTRACT,
                "topics": [TRANSFER_TOPIC]
            }])
            
            if logs:
                for log in logs:
                    topics = log.get('topics', [])
                    if len(topics) >= 3:
                        from_addr = '0x' + topics[1][26:].lower()
                        to_addr = '0x' + topics[2][26:].lower()
                        
                        if wallet.lower() in [from_addr, to_addr]:
                            amount = int(log.get('data', '0x0'), 16) / 1e18
                            direction = "RECEIVED" if to_addr == wallet.lower() else "SENT"
                            transfers.append({
                                'block': int(log['blockNumber'], 16),
                                'tx_hash': log['transactionHash'],
                                'amount': amount,
                                'direction': direction
                            })
            
            time.sleep(0.05)
        
        if tx_count == 0 and len(transfers) == 0:
            status = "INACTIVE"
            note = "No activity"
        elif is_contract:
            status = "CONTRACT/BOT"
            note = "Contract address"
        elif eth_balance == 0 and len(transfers) <= 2:
            status = "BURNER"
            note = "Drained funds"
        else:
            status = "ACTIVE_USER"
            note = f"{len(transfers)} transfers"
        
        print(f"  Status: {status} | Transfers: {len(transfers)}")
        
        info = {
            'address': wallet,
            'tx_count': tx_count,
            'eth_balance': eth_balance,
            'is_contract': is_contract,
            'status': status,
            'note': note,
            'transfers': transfers[:20]
        }
        results.append(info)
    
    print("\n\n" + "=" * 100)
    print("WALLET DASHBOARD")
    print("=" * 100)
    
    for r in results:
        icon = "📦" if r['is_contract'] else ("🔥" if r['status'] == 'BURNER' else "⚪")
        print(f"\n{icon} [{r['status']}] {r['address']}")
        print(f"   ETH: {r['eth_balance']:.4f} | TXs: {r['tx_count']} | Transfers: {len(r['transfers'])}")
        print(f"   Note: {r['note']}")
        
        if r['transfers']:
            buys = [t for t in r['transfers'] if t['direction'] == 'RECEIVED']
            if buys:
                print(f"   First Buy: {buys[0]['amount']:,.2f} tokens at block {buys[0]['block']}")
    
    with open("/home/ubuntu/.hermes/scripts/cluster-signal/mainnet_analysis.json", 'w') as f:
        json.dump(results, f, indent=2)
    print(f"\nSaved to: mainnet_analysis.json")

if __name__ == "__main__":
    main()
