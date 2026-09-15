#!/usr/bin/env python3
"""
Smart Cluster Builder v2 — supports both v3 and v4 Uniswap pairs
Finds active traders from a token CA, builds cluster for monitoring
"""
import sys
import requests
import json
import os
import time

TOKEN = sys.argv[1] if len(sys.argv) > 1 else None
if not TOKEN:
    print("Usage: python3 build_cluster.py <TOKEN_ADDRESS>")
    sys.exit(1)

RPC = "https://rpc.mainnet.chain.robinhood.com"
CHAIN_ID = 4663
SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64ec8ee59c2b20cb615f"
V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
DATA_FILE = "data/cluster.json"
MIN_SCORE = 100  # minimum score to be in cluster

def rpc(method, params):
    r = requests.post(RPC, json={"jsonrpc":"2.0","id":1,"method":method,"params":params}, timeout=30)
    return r.json().get("result")

print(f"🔍 Scanning {TOKEN[:10]}...")

# Step 1: Get pair from DexScreener
r = requests.get(f"https://api.dexscreener.com/latest/dex/tokens/{TOKEN}", timeout=30)
data = r.json()
if not data.get("pairs"):
    print("❌ No pairs found")
    sys.exit(1)

# Find best pair — prefer v3, fallback to v4
v3_pairs = [p for p in data["pairs"] if p.get("labels") and "v3" in p.get("labels", [])]
v4_pairs = [p for p in data["pairs"] if p.get("labels") and "v4" in p.get("labels", [])]

if v3_pairs:
    pair = v3_pairs[0]
    pair_type = "v3"
elif v4_pairs:
    pair = v4_pairs[0]
    pair_type = "v4"
else:
    pair = data["pairs"][0]
    pair_type = "unknown"

symbol = pair.get("baseToken", {}).get("symbol", "?")
name = pair.get("baseToken", {}).get("name", "?")
price = pair.get("priceUsd", "0")
pair_addr = pair.get("pairAddress", "").lower()
buys_24h = pair.get("txns", {}).get("h24", {}).get("buys", 0)
sells_24h = pair.get("txns", {}).get("h24", {}).get("sells", 0)

print(f"  Token: {name} ({symbol})")
print(f"  Price: ${price} | Type: {pair_type}")
print(f"  Pair: {pair_addr[:20]}...")
print(f"  24h: {buys_24h} buys / {sells_24h} sells")

# Step 2: Get current block
current_hex = rpc("eth_blockNumber", [])
current_block = int(current_hex, 16)
from_block = max(0, current_block - 5000)

print(f"\n📊 Scanning last 5000 blocks ({from_block:,} → {current_block:,})")

# Step 3: Query swap events based on pair type
all_swaps = []
if pair_type == "v3":
    # v3: query pair contract directly
    result = rpc("eth_getLogs", [{
        "fromBlock": hex(from_block),
        "toBlock": "latest",
        "address": pair_addr,
        "topics": [SWAP_TOPIC]
    }])
    if result and isinstance(result, list):
        all_swaps = result

elif pair_type == "v4":
    # v4: query PoolManager with pool ID in topics[1]
    result = rpc("eth_getLogs", [{
        "fromBlock": hex(from_block),
        "toBlock": "latest",
        "address": V4_POOL_MANAGER,
        "topics": [None, pair_addr]  # pool ID in topics[1]
    }])
    if result and isinstance(result, list):
        all_swaps = result
else:
    print("❌ Unknown pair type — only v3 and v4 supported")
    sys.exit(1)

print(f"  Found {len(all_swaps)} swaps")

if not all_swaps:
    print("❌ No swaps found in this range")
    sys.exit(1)

# Step 4: Trace TXs to find unique buyers
print("\n👥 Tracing transactions...")
seen_txs = set()
buyers = []

for swap in all_swaps[:200]:  # limit to 200 swaps
    tx_hash = swap["transactionHash"]
    if tx_hash in seen_txs:
        continue
    seen_txs.add(tx_hash)

    try:
        tx = rpc("eth_getTransactionByHash", [tx_hash])
        if tx and tx.get("from"):
            addr = tx["from"].lower()
            block = int(swap["blockNumber"], 16)
            buyers.append({"addr": addr, "block": block, "tx": tx_hash})
        time.sleep(0.05)
    except:
        pass

# Deduplicate by address
seen_addrs = set()
unique_buyers = []
for b in buyers:
    if b["addr"] not in seen_addrs:
        seen_addrs.add(b["addr"])
        unique_buyers.append(b)

print(f"  Found {len(unique_buyers)} unique buyers")

# Step 5: Filter for active traders (EOAs with activity)
print("\n💰 Filtering active traders...")
profitable = []

for b in unique_buyers:
    addr = b["addr"]
    try:
        code = rpc("eth_getCode", [addr, "latest"])
        if code and code != "0x" and len(code) > 2:
            continue  # contract, skip

        nonce = int(rpc("eth_getTransactionCount", [addr, "latest"]) or "0x0", 16)
        bal = int(rpc("eth_getBalance", [addr, "latest"]) or "0x0", 16)
        eth_bal = bal / 1e18

        # Active trader: nonce 10+ AND balance > 0.005 ETH
        if nonce >= 10 and eth_bal >= 0.005:
            score = min(nonce, 500) + min(int(eth_bal * 100), 200)
            if score >= MIN_SCORE:
                profitable.append({
                    "wallet": addr,
                    "buy_block": b["block"],
                    "tx": b["tx"],
                    "nonce": nonce,
                    "balance_eth": round(eth_bal, 6),
                    "score": score,
                    "source": f"CA:{TOKEN[:10]}",
                    "token": name,
                    "symbol": symbol
                })
        time.sleep(0.05)
    except:
        pass

profitable.sort(key=lambda x: x["score"], reverse=True)

print(f"\n✅ Active traders found: {len(profitable)}")
for p in profitable[:15]:
    print(f"  {p['wallet'][:10]}... | score={p['score']} | nonce={p['nonce']} | bal={p['balance_eth']}ETH | block={p['buy_block']}")

if len(profitable) > 15:
    print(f"  ... and {len(profitable) - 15} more")

# Step 6: Save cluster
os.makedirs("data", exist_ok=True)
with open(DATA_FILE, "w") as f:
    json.dump(profitable, f, indent=2)

print(f"\n💾 Cluster saved: {DATA_FILE}")
print(f"   {len(profitable)} wallets ready for monitoring")
