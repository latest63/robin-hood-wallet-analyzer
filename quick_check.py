#!/usr/bin/env python3
import json
import urllib.request
import ssl

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

def rpc(method, params):
    payload = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(RPC_URL, data=data, headers={'Content-Type': 'application/json'})
    try:
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
            return json.loads(r.read().decode()).get('result')
    except:
        return None

print("=" * 80)
print("MAINNET WALLET QUICK CHECK")
print("=" * 80)

for wallet in TARGET_WALLETS:
    print(f"\n{wallet}")
    
    balance = rpc("eth_getBalance", [wallet, "latest"])
    code = rpc("eth_getCode", [wallet, "latest"])
    nonce = rpc("eth_getTransactionCount", [wallet, "latest"])
    
    eth_bal = int(balance, 16) / 1e18 if balance else 0
    tx_count = int(nonce, 16) if nonce else 0
    is_contract = bool(code and code != "0x")
    
    print(f"  ETH: {eth_bal:.4f} | TXs: {tx_count} | Contract: {is_contract}")
    
    result = rpc("eth_getLogs", [{
        "fromBlock": hex(DEPLOY_BLOCK),
        "toBlock": hex(DEPLOY_BLOCK + 500),
        "address": TOKEN_CONTRACT,
        "topics": [TRANSFER_TOPIC]
    }])
    
    transfers = []
    if result:
        for log in result:
            topics = log.get('topics', [])
            if len(topics) >= 3:
                from_addr = '0x' + topics[1][26:].lower()
                to_addr = '0x' + topics[2][26:].lower()
                if wallet.lower() in [from_addr, to_addr]:
                    amount = int(log.get('data', '0x0'), 16) / 1e18
                    direction = "RECEIVED" if to_addr == wallet.lower() else "SENT"
                    transfers.append({'tx': log['transactionHash'], 'amount': amount, 'dir': direction})
    
    if transfers:
        print(f"  Transfers found: {len(transfers)}")
        for t in transfers[:5]:
            print(f"    {t['dir']}: {t['amount']:,.2f} | {t['tx'][:20]}...")
    else:
        print("  No transfers in first 500 blocks after deploy")
