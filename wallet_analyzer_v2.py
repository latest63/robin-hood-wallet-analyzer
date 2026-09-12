#!/usr/bin/env python3
"""Wallet Analyzer Dashboard - Fixed version"""
import json
import time
import urllib.request
import ssl

RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
TOKEN_CONTRACT = "0x385f4f8ae47651ce5f58f5265395a669f8281e18"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
BLOCKS_PER_QUERY = 500
ssl._create_default_https_context = ssl._create_unverified_context

def rpc_call(method, params):
    payload = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(RPC_URL, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode()).get('result')
    except Exception as e:
        return None

def analyze_wallet(address, start_block, end_block):
    """Analyze a wallet's token activity"""
    info = {
        'address': address,
        'is_contract': False,
        'eth_balance': 0,
        'token_tx_count': 0,
        'first_activity': None,
        'last_activity': None,
        'recipients': [],
        'total_tokens_sent': 0,
        'total_tokens_received': 0
    }
    
    # Check if contract
    code = rpc_call("eth_getCode", [address, "latest"])
    info['is_contract'] = bool(code and code != "0x")
    
    # Get ETH balance
    balance_wei = rpc_call("eth_getBalance", [address, "latest"])
    if balance_wei:
        info['eth_balance'] = int(balance_wei, 16) / 1e18
    
    # Scan blocks for transfers involving this wallet
    for block_num in range(start_block, end_block + 1, BLOCKS_PER_QUERY):
        block_end = min(block_num + BLOCKS_PER_QUERY - 1, end_block)
        
        # Get block range logs directly
        result = rpc_call("eth_getLogs", [{
            "fromBlock": hex(block_num),
            "toBlock": hex(block_end),
            "address": TOKEN_CONTRACT,
            "topics": [TRANSFER_TOPIC, None, None]  # All transfers
        }])
        
        if not result or 'error' in result:
            continue
        
        for log in result:
            if log.get('topics', []) and log['topics'][0] == TRANSFER_TOPIC:
                from_addr = '0x' + log['topics'][1][26:].lower()
                to_addr = '0x' + log['topics'][2][26:].lower()
                
                # Check if our wallet is involved
                if address.lower() in [from_addr, to_addr]:
                    info['token_tx_count'] += 1
                    
                    if info['first_activity'] is None or int(log['blockNumber'], 16) < info['first_activity']:
                        info['first_activity'] = int(log['blockNumber'], 16)
                    if info['last_activity'] is None or int(log['blockNumber'], 16) > info['last_activity']:
                        info['last_activity'] = int(log['blockNumber'], 16)
                    
                    # Parse amount
                    try:
                        amount = int(log.get('data', '0x0'), 16) / 1e18
                    except:
                        amount = 0
                    
                    # Track flows
                    if from_addr == address.lower():
                        info['total_tokens_sent'] += amount
                        info['recipients'].append({'addr': to_addr, 'amount': amount})
                    elif to_addr == address.lower():
                        info['total_tokens_received'] += amount
        
        time.sleep(0.1)  # Rate limit
    
    # Determine status
    status = "UNKNOWN"
    note = ""
    
    if info['is_contract']:
        status = "CONTRACT"
        note = "Contract address - likely bot/DEX/multisig"
    elif info['eth_balance'] == 0 and info['token_tx_count'] > 0:
        status = "BURNER"
        note = "No ETH balance - may have drained/spent all funds"
    elif info['token_tx_count'] == 0:
        status = "INACTIVE"
        note = "No token activity found"
    else:
        status = "ACTIVE_USER"
        note = "Has ongoing activity"
    
    if info['token_tx_count'] > 100 and not info['is_contract']:
        status = "LIKELY_BOT"
        note = "High tx count without contract - potential bot/scalper"
    
    info['status'] = status
    info['note'] = note
    
    return info

def main():
    print("=" * 80)
    print("ROBINHOOD CHAIN WALLET ANALYZER v2")
    print(f"Token: {TOKEN_CONTRACT}")
    print("=" * 80)
    
    early_wallets = [
        "0x24d655a4ed48bfd4291de041a1f81a11ca456aa6",
        "0xcc941b23420b1a402e8972b5b3fc329de9ac19df",
        "0x92d435c96e63c43e12d6d0ab28f6b0b04072f765",
        "0x4d192365c30928533577a023b05663e5f48b3025",
        "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
    ]
    
    start_block = 53946846
    end_block = 53956846  # First 10K blocks
    
    results = []
    
    print(f"\nAnalyzing {len(early_wallets)} early wallets...\n")
    
    for i, wallet in enumerate(early_wallets):
        print(f"[{i+1}/{len(early_wallets)}] Scanning {wallet[:20]}...")
        info = analyze_wallet(wallet, start_block, end_block)
        print(f"  Status: {info['status']} | ETH: {info['eth_balance']:.4f} | TXs: {info['token_tx_count']}")
        print(f"  Received: {info['total_tokens_received']:,.2f} | Sent: {info['total_tokens_sent']:,.2f}")
        results.append(info)
    
    # Print summary
    print("\n" + "=" * 80)
    print("WALLET ANALYSIS RESULTS")
    print("=" * 80)
    
    for r in results:
        icon = "📦" if r['is_contract'] else ("🔥" if r['status'] == 'BURNER' else "✅" if r['status'] == 'ACTIVE_USER' else "⚪")
        
        print(f"\n{icon} [{r['status']}] {r['address']}")
        print(f"   ETH Balance: {r['eth_balance']:.6f}")
        print(f"   Token Transactions: {r['token_tx_count']}")
        print(f"   Tokens Received: {r['total_tokens_received']:,.2f}")
        print(f"   Tokens Sent: {r['total_tokens_sent']:,.2f}")
        print(f"   Activity: Block {r['first_activity']} → Block {r['last_activity']}")
        print(f"   Note: {r['note']}")
        
        if r['recipients'] and r['total_tokens_sent'] > 0:
            print(f"   Token Flow (top recipients):")
            sorted_recips = sorted(r['recipients'], key=lambda x: x['amount'], reverse=True)[:5]
            for rec in sorted_recips:
                print(f"     → {rec['addr']}: {rec['amount']:,.2f} tokens")
    
    # Save
    output_file = "/home/ubuntu/.hermes/scripts/cluster-signal/wallet_analysis.json"
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"\n\nFull results saved to: {output_file}")

if __name__ == "__main__":
    main()