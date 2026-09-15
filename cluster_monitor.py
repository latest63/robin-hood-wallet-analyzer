#!/usr/bin/env python3
"""
Cluster Builder + Monitor v4
Supports v3 and v4 Uniswap pairs on Robin Hood Chain (4663)

v4: wallet in topics[2] is the router/contract, NOT the human.
    Must trace TX to find the actual buyer (tx.from).

v3: pair contract emits Swap, trace TX to find buyer.

Usage:
  python3 cluster_monitor.py <TOKEN_CA>                    # Build cluster
  python3 cluster_monitor.py <TOKEN_CA> monitor            # Build + monitor
  python3 cluster_monitor.py <TOKEN_CA> monitor <webhook>  # Build + monitor + Discord
"""
import sys
import requests
import json
import os
import time
from datetime import datetime

TOKEN = sys.argv[1] if len(sys.argv) > 1 else None
if not TOKEN:
    print("Usage: python3 cluster_monitor.py <TOKEN_CA> [monitor] [webhook]")
    sys.exit(1)

MODE = sys.argv[2] if len(sys.argv) > 2 else "build"
WEBHOOK = sys.argv[3] if len(sys.argv) > 3 else None

RPC = "https://rpc.mainnet.chain.robinhood.com"
CHAIN_ID = 4663
V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64ec8ee59c2b20cb615f"
V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
DATA_FILE = "data/cluster.json"
POLL_SECONDS = 5
MIN_SCORE = 50
BLOCKS_TO_SCAN = 5000

def rpc(method, params):
    r = requests.post(RPC, json={"jsonrpc":"2.0","id":1,"method":method,"params":params}, timeout=30)
    return r.json().get("result")

def send_discord(wallet, block, score, symbol):
    if not WEBHOOK:
        return
    try:
        payload = {
            "embeds": [{
                "title": f"�� Cluster Buy Alert — {symbol}",
                "description": f"**Wallet:** [`{wallet[:10]}...{wallet[-6:]}`](https://explorer.mainnet.chain.robinhood.com/address/{wallet})\n**Score:** {score}\n**Block:** {block:,}",
                "color": 0x00ff00,
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "footer": {"text": "Cluster Monitor • robinhood chain"}
            }]
        }
        requests.post(WEBHOOK, json=payload, timeout=10,
                      headers={"User-Agent": "ClusterMonitor/1.0"})
    except:
        pass

# ─── STEP 1: Find pair ───
print(f"�� Scanning {TOKEN[:10]}...")
r = requests.get(f"https://api.dexscreener.com/latest/dex/tokens/{TOKEN}", timeout=30)
data = r.json()
if not data.get("pairs"):
    print("❌ No pairs found")
    sys.exit(1)

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

print(f"  Token: {name} ({symbol})")
print(f"  Price: ${price} | Type: {pair_type}")
print(f"  24h buys: {buys_24h}")

# ─── STEP 2: Get swaps ───
current_hex = rpc("eth_blockNumber", [])
current_block = int(current_hex, 16)
from_block = max(0, current_block - BLOCKS_TO_SCAN)

print(f"\n�� Scanning blocks {from_block:,} → {current_block:,}")

all_swaps = []
if pair_type == "v3":
    result = rpc("eth_getLogs", [{
        "fromBlock": hex(from_block),
        "toBlock": "latest",
        "address": pair_addr,
        "topics": [V3_SWAP_TOPIC]
    }])
elif pair_type == "v4":
    result = rpc("eth_getLogs", [{
        "fromBlock": hex(from_block),
        "toBlock": "latest",
        "address": V4_POOL_MANAGER,
        "topics": [V4_SWAP_TOPIC, pair_addr]
    }])
else:
    print("❌ Unknown pair type")
    sys.exit(1)

if result and isinstance(result, list):
    all_swaps = result

print(f"  Found {len(all_swaps)} swaps")

if not all_swaps:
    print("❌ No swaps found")
    sys.exit(1)

# ─── STEP 3: Trace TXs to find real buyers ───
print("\n�� Tracing transactions to find real buyers...")
seen_txs = set()
buyers = []

for swap in all_swaps:
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

seen_addrs = set()
unique_buyers = []
for b in buyers:
    if b["addr"] not in seen_addrs:
        seen_addrs.add(b["addr"])
        unique_buyers.append(b)

print(f"  {len(unique_buyers)} unique real buyers")

# ─── STEP 4: Filter EOAs with activity ───
print("\n�� Filtering active traders...")
profitable = []

for b in unique_buyers:
    addr = b["addr"]
    try:
        code = rpc("eth_getCode", [addr, "latest"])
        if code and code != "0x" and len(code) > 2:
            continue

        nonce = int(rpc("eth_getTransactionCount", [addr, "latest"]) or "0x0", 16)
        bal = int(rpc("eth_getBalance", [addr, "latest"]) or "0x0", 16)
        eth_bal = bal / 1e18

        # Active trader: nonce 5+ AND balance > 0.001 ETH
        if nonce >= 5 and eth_bal >= 0.001:
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

print(f"\n✅ Cluster: {len(profitable)} wallets")
for p in profitable[:10]:
    print(f"  {p['wallet'][:10]}... | score={p['score']} | nonce={p['nonce']} | {p['balance_eth']}ETH")

os.makedirs("data", exist_ok=True)
with open(DATA_FILE, "w") as f:
    json.dump(profitable, f, indent=2)

print(f"\n�� Saved: {DATA_FILE} ({len(profitable)} wallets)")

if MODE != "monitor":
    print(f"\n▶️ Monitor: python3 cluster_monitor.py {TOKEN} monitor [webhook]")
    sys.exit(0)

# ─── STEP 5: Monitor loop ───
print(f"\n�� Monitoring cluster (poll every {POLL_SECONDS}s)...")
if WEBHOOK:
    print(f"  Discord → {WEBHOOK[:50]}...")
else:
    print(f"  Console alerts only")

cluster_wallets = set(p["wallet"] for p in profitable)
last_block = current_block
alert_count = 0

try:
    while True:
        try:
            latest_hex = rpc("eth_blockNumber", [])
            latest_block = int(latest_hex, 16)

            if latest_block <= last_block:
                time.sleep(POLL_SECONDS)
                continue

            # Query new swaps
            if pair_type == "v3":
                result = rpc("eth_getLogs", [{
                    "fromBlock": hex(last_block + 1),
                    "toBlock": hex(latest_block),
                    "address": pair_addr,
                    "topics": [V3_SWAP_TOPIC]
                }])
            else:
                result = rpc("eth_getLogs", [{
                    "fromBlock": hex(last_block + 1),
                    "toBlock": hex(latest_block),
                    "address": V4_POOL_MANAGER,
                    "topics": [V4_SWAP_TOPIC, pair_addr]
                }])

            new_swaps = result if result and isinstance(result, list) else []
            last_block = latest_block

            for swap in new_swaps:
                tx_hash = swap["transactionHash"]
                try:
                    tx = rpc("eth_getTransactionByHash", [tx_hash])
                    if tx and tx.get("from"):
                        buyer = tx["from"].lower()
                        if buyer in cluster_wallets:
                            alert_count += 1
                            block = int(swap["blockNumber"], 16)
                            matched = [p for p in profitable if p["wallet"] == buyer][0]
                            ts = datetime.now().strftime("%H:%M:%S")
                            print(f"\n�� [{ts}] CLUSTER BUY!")
                            print(f"   Wallet: {buyer}")
                            print(f"   Score: {matched['score']}")
                            print(f"   Block: {block:,}")
                            send_discord(buyer, block, matched["score"], symbol)
                except:
                    pass

            time.sleep(POLL_SECONDS)

        except KeyboardInterrupt:
            raise
        except Exception as e:
            print(f"⚠️ {e}")
            time.sleep(POLL_SECONDS)

except KeyboardInterrupt:
    print(f"\n\n⏹ Stopped. {alert_count} alerts fired.")
