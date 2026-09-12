#!/usr/bin/env python3
"""Wallet Analyzer Dashboard - Explorer API Version"""
import json
import urllib.request
import ssl

EXPLORER_URL="https://explorer.testnet.chain.robinhood.com/api/v2"
TOKEN_CONTRACT="0x385f4f8ae47651ce5f58f5265395a669f8281e18"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

def api_call(endpoint):
    url = f"{EXPLORER_URL}/{endpoint}"
    req = urllib.request.Request(url)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"error": str(e)}

def analyze_wallet_explorer(address):
    """Analyze wallet using explorer API"""
    print(f"\n=== Analyzing {address} ===")
    
    # Get address info
    result = api_call(f"addresses/{address}")
    
    if 'error' in result or isinstance(result, dict) and 'message' in result:
        print(f"  No data found or error")
        return None
    
    info = {
        'address': address,
        'is_contract': result.get('is_contract', False),
        'tx_count': int(result.get('transactions_count', 0)),
        'eth_balance': int(result.get('coin_balance', 0)) / 1e18,
        'name': result.get('name', ''),
        'public_tags': result.get('public_tags', [])
    }
    
    print(f"  Type: {'Contract' if info['is_contract'] else 'EOA'}")
    print(f"  Total TXs: {info['tx_count']}")
    print(f"  ETH Balance: {info['eth_balance']:.4f}")
    if info['public_tags']:
        print(f"  Tags: {info['public_tags']}")
    
    # Get transaction list
    txs_result = api_call(f"addresses/{address}/transactions?limit=50")
    if 'error' not in txs_result:
        txs = txs_result.get('items', [])
        print(f"  Recent TXs: {len(txs)}")
        
        # Look for token-related activity
        for tx in txs[:10]:
            method = tx.get('method_id', '')
            if method in ['0xa9059cbb', '0x095ea7b3']:  # transfer or approve
                print(f"    TX {tx['hash'][:16]}... Method: {method[:8]} Value: {tx.get('value', '0')}")
    
    return info

def get_token_transfers():
    """Get token transfers from explorer"""
    print("\nFetching token transfers...")
    
    # Try different endpoints
    endpoints_to_try = [
        f"token-transfers?token_address={TOKEN_CONTRACT}&limit=50&sort=asc",
        f"addresses/{TOKEN_CONTRACT}/token-transfers?limit=50&sort=asc"
    ]
    
    for endpoint in endpoints_to_try:
        result = api_call(endpoint)
        if 'error' not in result and 'items' in result:
            print(f"  Found {len(result['items'])} transfers via: {endpoint}")
            return result['items']
        elif 'error' in result:
            print(f"  Error: {result['error']}")
    
    return []

def main():
    print("=" * 80)
    print("ROBINHOOD CHAIN WALLET ANALYZER v3 (Explorer API)")
    print(f"Token: {TOKEN_CONTRACT}")
    print("=" * 80)
    
    # Get token transfers first
    transfers = get_token_transfers()
    
    if transfers:
        print("\nFirst 10 transfers:")
        for i, t in enumerate(transfers[:10]):
            print(f"[{i+1}] {t.get('transaction_hash', 'N/A')[:20]}... | From: {t.get('sender_address', 'N/A')[:20]}... | To: {t.get('receiver_address', 'N/A')[:20]}... | Amount: {int(t.get('value', 0)) / 1e18:.2f}")
    
    # Analyze early wallets
    wallets = [
        "0x24d655a4ed48bfd4291de041a1f81a11ca456aa6",
        "0xcc941b23420b1a402e8972b5b3fc329de9ac19df",
        "0x92d435c96e63c43e12d6d0ab28f6b0b04072f765",
        "0x4d192365c30928533577a023b05663e5f48b3025",
        "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
    ]
    
    results = []
    for wallet in wallets:
        info = analyze_wallet_explorer(wallet)
        if info:
            results.append(info)
    
    # Save results
    output_file = "/home/ubuntu/.hermes/scripts/cluster-signal/wallet_analysis.json"
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"\n\nResults saved to: {output_file}")

if __name__ == "__main__":
    main()
