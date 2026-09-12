#!/usr/bin/env python3
"""Mainnet Wallet Analyzer - No testnet, no browser automation"""
import json
import urllib.request
import ssl
import time

RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
TOKEN_CONTRACT="0x385f4f8ae47651ce5f58f5265395a669f8281e18"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# Your target wallets
TARGET_WALLETS = [
    "0x24d655a4ed48bfd4291de041a1f81a11ca456aa6",
    "0xcc941b23420b1a402e8972b5b3fc329de9ac19df",
    "0x92d435c96e63c43e12d6d0ab28f6b0b04072f765",
    "0x4d192365c30928533577a023b05663e5f48b3025",
    "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
]

# Token deploy block (from earlier analysis)
DEPLOY_BLOCK = 53946846

def rpc_call(method, params):
    """Make JSON-RPC call with retries"""
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

def get_balance(address):
    """Get ETH balance"""
    result = rpc_call("eth_getBalance", [address, "latest"])
    if result:
        return int(result, 16) / 1e18
    return 0

def is_contract(address):
    """Check if address has code"""
    code = rpc_call("eth_getCode", [address, "latest"])
    return bool(code and code != "0x")

def scan_transfers_for_wallet(wallet, start_block, end_block, batch_size=500):
    """Scan blocks for token transfers involving wallet"""
    transfers = []
    
    for block_start in range(start_block, end_block + 1, batch_size):
        block_end = min(block_start + batch_size - 1, end_block)
        
        # Query logs for this block range
        result = rpc_call("eth_getLogs", [{
            "fromBlock": hex(block_start),
            "toBlock": hex(block_end),
            "address": TOKEN_CONTRACT,
            "topics": [TRANSFER_TOPIC]
        }])
        
        if not result or 'error' in result:
            continue
        
        for log in result:
            topics = log.get('topics', [])
            if len(topics) >= 3 and topics[0] == TRANSFER_TOPIC:
                from_addr = '0x' + topics[1][26:].lower()
                to_addr = '0x' + topics[2][26:].lower()
                
                if wallet.lower() in [from_addr, to_addr]:
                    amount = int(log.get('data', '0x0'), 16) / 1e18
                    transfers.append({
                        'block': int(log['blockNumber'], 16),
                        'tx_hash': log['transactionHash'],
                        'from': from_addr,
                        'to': to_addr,
                        'amount': amount,
                        'direction': 'RECEIVED' if to_addr == wallet.lower() else 'SENT'
                    })
        
        time.sleep(0.1)  # Rate limiting
    
    return transfers

def main():
    print("=" * 100)
    print("MAINNET WALLET ANALYZER")
    print(f"Token: {TOKEN_CONTRACT}")
    print(f"Deploy Block: {DEPLOY_BLOCK}")
    print("=" * 100)
    
    # Get current block for reference
    current_block_hex = rpc_call("eth_blockNumber", [])
    current_block = int(current_block_hex, 16) if current_block_hex else 0
    print(f"Current Block: {current_block:,}\n")
    
    results = []
    
    for i, wallet in enumerate(TARGET_WALLETS):
        print(f"[{i+1}/{len(TARGET_WALLETS)}] Analyzing {wallet[:20]}...")
        
        # Check basic properties
        contract_status = is_contract(wallet)
        eth_balance = get_balance(wallet)
        
        print(f"  Is Contract: {contract_status}")
        print(f"  ETH Balance: {eth_balance:.6f}")
        
        # Scan for transfers (first 1M blocks after deploy = ~117K blocks)
        transfers = scan_transfers_for_wallet(wallet, DEPLOY_BLOCK, DEPLOY_BLOCK + 100000)
        
        # Categorize
        if len(transfers) == 0:
            status = "INACTIVE"
            note = "No token activity found"
        elif contract_status:
            status = "CONTRACT/BOT"
            note = "Contract address handling tokens"
        elif eth_balance == 0 and len(transfers) <= 2:
            status = "BURNER"
            note = "Drained all funds after receiving"
        else:
            status = "ACTIVE_USER"
            note = f"Has ongoing activity ({len(transfers)} txs)"
        
        # Get first buy (RECEIVED transfer)
        buy_tx = None
        buy_amount = 0
        for t in transfers:
            if t['direction'] == 'RECEIVED':
                buy_tx = t['tx_hash']
                buy_amount = t['amount']
                break
        
        print(f"  Status: {status}")
        print(f"  Token Transfers: {len(transfers)}")
        if buy_tx:
            print(f"  First Buy TX: {buy_tx[:20]}...")
            print(f"  First Buy Amount: {buy_amount:,.2f}")
        
        info = {
            'address': wallet,
            'is_contract': contract_status,
            'eth_balance': eth_balance,
            'status': status,
            'note': note,
            'total_transfers': len(transfers),
            'first_buy_tx': buy_tx,
            'first_buy_amount': buy_amount,
            'transfers': transfers[:20]  # Save first 20 for tracking
        }
        
        results.append(info)
        print()
    
    # Print summary dashboard
    print("\n" + "=" * 100)
    print("WALLET DASHBOARD SUMMARY")
    print("=" * 100)
    
    contracts = [r for r in results if r['is_contract']]
    burners = [r for r in results if r['status'] == 'BURNER']
    active = [r for r in results if r['status'] == 'ACTIVE_USER']
    inactive = [r for r in results if r['status'] == 'INACTIVE']
    
    print(f"\n📦 Contracts/Bots: {len(contracts)}")
    for r in contracts:
        print(f"   {r['address']} - {r['note']}")
    
    print(f"\n🔥 Burners (drained): {len(burners)}")
    for r in burners:
        print(f"   {r['address']}")
    
    print(f"\n✅ Active Users: {len(active)}")
    for r in active:
        print(f"   {r['address']}")
        if r['first_buy_tx']:
            print(f"      Buy TX: {r['first_buy_tx']}")
            print(f"      Buy Amount: {r['first_buy_amount']:,.2f} tokens")
    
    print(f"\n⚪ Inactive: {len(inactive)}")
    
    # Save full results
    output_file = "/home/ubuntu/.hermes/scripts/cluster-signal/wallet_analysis_mainnet.json"
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"\n\nFull analysis saved to: {output_file}")

if __name__ == "__main__":
    main()
