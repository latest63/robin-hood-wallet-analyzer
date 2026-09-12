#!/usr/bin/env python3
"""Wallet Analyzer - Using testnet explorer (which has data)"""
import json
import urllib.request
import ssl

EXPLORER_URL="https://explorer.testnet.chain.robinhood.com/api/v2"
TOKEN_CONTRACT="0x385f4f8ae47651ce5f58f5265395a669f8281e18"

def api_call(endpoint):
    url = f"{EXPLORER_URL}/{endpoint}"
    req = urllib.request.Request(url)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"error": str(e)}

def analyze_wallet(address):
    """Analyze wallet from explorer"""
    print(f"\n=== {address} ===")
    
    # Get address details
    result = api_call(f"addresses/{address}")
    
    if 'error' in result:
        print(f"  Error: {result['error']}")
        return None
    
    is_contract = result.get('is_contract', False)
    tx_count = int(result.get('transactions_count', 0) or 0)
    
    print(f"  Contract: {'Yes' if is_contract else 'No'}")
    print(f"  Total TXs: {tx_count}")
    
    # Get first transactions (oldest first via sort=asc)
    txs_result = api_call(f"addresses/{address}/transactions?sort=asc&limit=100")
    
    if 'error' not in txs_result and 'items' in txs_result:
        txs = txs_result['items']
        print(f"  Found {len(txs)} transactions")
        
        # Check first transaction block
        if txs:
            first_block = txs[0].get('block_number')
            last_block = txs[-1].get('block_number')
            print(f"  First TX Block: {first_block}")
            print(f"  Last TX Block: {last_block}")
            
            # Show early activity
            for tx in txs[:3]:
                method = tx.get('method_id', 'unknown')
                hash_short = tx.get('hash', '')[:16]
                print(f"    Early TX: {hash_short}... Method: {method}")
        
        return {
            'address': address,
            'is_contract': is_contract,
            'tx_count': tx_count,
            'first_block': first_block if txs else None,
            'last_block': last_block if txs else None,
            'early_txs': txs[:5] if txs else []
        }
    
    return {
        'address': address,
        'is_contract': is_contract,
        'tx_count': tx_count
    }

def get_token_transfers():
    """Get all token transfers for this token"""
    print("\nFetching token transfers...")
    
    # Try getting transfers for the token contract
    result = api_call(f"token-transfers?token_address_hash={TOKEN_CONTRACT}&limit=200&sort=asc")
    
    if 'error' not in result and 'items' in result:
        transfers = result['items']
        print(f"  Found {len(transfers)} transfers")
        
        # Collect unique recipients from first batch
        recipients = {}
        for t in transfers[:50]:
            receiver = t.get('to', {}).get('hash') or t.get('receiver_address')
            sender = t.get('from', {}).get('hash') or t.get('sender_address')
            amount = t.get('value', 0) or t.get('total', 0)
            
            if receiver and receiver.lower() != TOKEN_CONTRACT.lower():
                if receiver not in recipients:
                    recipients[receiver] = {'received': 0, 'count': 0}
                recipients[receiver]['received'] += int(amount or 0)
                recipients[receiver]['count'] += 1
        
        return recipients, transfers
    else:
        print(f"  Error: {result.get('error', 'Unknown')}")
        return {}, []

def main():
    print("=" * 80)
    print("ROBINHOOD CHAIN WALLET ANALYZER v4 (Explorer)")
    print(f"Token: {TOKEN_CONTRACT}")
    print("=" * 80)
    
    # Get token transfers first
    recipients, transfers = get_token_transfers()
    
    if recipients:
        print("\nTop early recipients:")
        sorted_receivers = sorted(recipients.items(), key=lambda x: x[1]['received'], reverse=True)[:20]
        for addr, data in sorted_receivers:
            print(f"  {addr}: received {data['received']:,} tokens ({data['count']} txs)")
    
    # Analyze specific wallets
    wallets = [
        "0x24d655a4ed48bfd4291de041a1f81a11ca456aa6",
        "0xcc941b23420b1a402e8972b5b3fc329de9ac19df",
        "0x92d435c96e63c43e12d6d0ab28f6b0b04072f765",
        "0x4d192365c30928533577a023b05663e5f48b3025",
        "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
    ]
    
    results = []
    for wallet in wallets:
        info = analyze_wallet(wallet)
        if info:
            results.append(info)
    
    # Categorize wallets
    print("\n" + "=" * 80)
    print("WALLET CATEGORIZATION")
    print("=" * 80)
    
    contracts = []
    users = []
    burners = []
    
    for r in results:
        if r['is_contract']:
            contracts.append(r)
        elif r['tx_count'] == 0:
            burners.append(r)
        else:
            users.append(r)
    
    print(f"\n📦 Contracts/Bots: {len(contracts)}")
    for c in contracts:
        print(f"   {c['address'][:20]}... (TXs: {c['tx_count']})")
    
    print(f"\n✅ Active Users: {len(users)}")
    for u in users:
        print(f"   {u['address'][:20]}... (First: Block {u['first_block']}, Last: Block {u['last_block']})")
    
    print(f"\n⚪ Burners/Inactive: {len(burners)}")
    for b in burners:
        print(f"   {b['address'][:20]}... (TXs: {b['tx_count']})")
    
    # Save
    output_file = "/home/ubuntu/.hermes/scripts/cluster-signal/wallet_analysis.json"
    with open(output_file, 'w') as f:
        json.dump({
            'token': TOKEN_CONTRACT,
            'recipients': dict(list(recipients.items())[:50]) if recipients else {},
            'analyzed_wallets': results
        }, f, indent=2)
    print(f"\n\nResults saved to: {output_file}")

if __name__ == "__main__":
    main()
