#!/usr/bin/env python3
"""
Deep scanner: find early buyers (first 20 blocks of token activity),
check if they are EOAs + active traders, add to cluster.
"""
import sys, requests, json, os, time

TOKEN = sys.argv[1] if len(sys.argv) > 1 else "0xa43a9b6EEdD8204F445237Bf72775eD9b1723d45"
RPC = "https://rpc.mainnet.chain.robinhood.com"
CHAIN_ID = 4663
SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64ec8ee59c2b20cb615f"
DATA_FILE = "data/cluster.json"

def rpc(method, params):
    r = requests.post(RPC, json={"jsonrpc":"2.0","id":1,"method":method,"params":params}, timeout=30)
    return r.json().get("result")

def get_hex_block(block_num):
    return hex(block_num)

# Step 1: Get token info from DexScreener
print(f"🔍 Deep scanning {TOKEN[:10]}...")
r = requests.get(f"https://api.dexscreener.com/latest/dex/tokens/{TOKEN}", timeout=30)
data = r.json()
if not data.get("pairs"):
    print("❌ No pairs found")
    sys.exit(1)

pair = data["pairs"][0]
symbol = pair.get("baseToken", {}).get("symbol", "?")
name = pair.get("baseToken", {}).get("name", "?")
price = pair.get("priceUsd", "?")
pair_addr = pair.get("pairAddress", "").lower()
dex_type = "v3" if "v3" in pair.get("dexId","") else "v4" if "v4" in pair.get("dexId","") else pair.get("dexId","")

print(f"  Token: {name} ({symbol})")
print(f"  Price: ${price} | DEX: {dex_type}")
print(f"  Pair: {pair_addr}")

# Step 2: Get current block and scan from way back
current_hex = rpc("eth_blockNumber", [])
current_block = int(current_hex, 16)

# Scan last 10,000 blocks (~20 min at 0.117s/block)
scan_from = max(0, current_block - 10000)
print(f"\n📊 Scanning blocks {scan_from:,} → {current_block:,} (last 10k blocks)")

# Query in chunks of 2000 blocks to avoid RPC limits
all_swaps = []
chunk_size = 2000
for start in range(scan_from, current_block, chunk_size):
    end = min(start + chunk_size - 1, current_block)
    try:
        if dex_type == "v3":
            result = rpc("eth_getLogs", [{
                "fromBlock": get_hex_block(start),
                "toBlock": get_hex_block(end),
                "address": pair_addr,
                "topics": [SWAP_TOPIC]
            }])
        elif dex_type == "v4":
            POOL_MANAGER = "0x83668101b8f0a0980a44c03d52f06cb67478654a"
            result = rpc("eth_getLogs", [{
                "fromBlock": get_hex_block(start),
                "toBlock": get_hex_block(end),
                "address": POOL_MANAGER,
                "topics": [SWAP_TOPIC]
            }])
        else:
            continue

        if result and not isinstance(result, dict):
            all_swaps.extend(result)
        time.sleep(0.2)  # rate limit
    except Exception as e:
        print(f"  ⚠️ Block {start:,}: {e}")
        time.sleep(1)

print(f"  Found {len(all_swaps)} swaps")

# Step 3: Trace first 50 unique TXs to find early buyers
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

    if len(buyers) >= 50:
        break

print(f"\n👤 Traced {len(buyers)} unique TXs")

# Step 4: Filter EOAs (no code) + check activity (nonce, balance)
profitable = []
for b in buyers:
    addr = b["addr"]
    try:
        code = rpc("eth_getCode", [addr, "latest"])
        if code and code != "0x" and len(code) > 2:
            continue  # contract, skip

        nonce = int(rpc("eth_getTransactionCount", [addr, "latest"]) or "0x0", 16)
        bal = int(rpc("eth_getBalance", [addr, "latest"]) or "0x0", 16)
        eth_bal = bal / 1e18

        # Active trader: nonce 10+ AND balance > 0.001 ETH
        if nonce >= 10 and eth_bal >= 0.001:
            score = min(nonce, 500) + min(int(eth_bal * 100), 200)
            profitable.append({
                "wallet": addr,
                "buy_block": b["block"],
                "tx": b["tx"],
                "nonce": nonce,
                "balance_eth": round(eth_bal, 6),
                "score": score,
                "source": f"CA:{TOKEN[:10]}"
            })
        time.sleep(0.05)
    except:
        pass

profitable.sort(key=lambda x: x["score"], reverse=True)

print(f"\n💰 Profitable wallets (active traders): {len(profitable)}")
for p in profitable[:10]:
    print(f"  ✅ {p['wallet'][:10]}... score={p['score']} nonce={p['nonce']} bal={p['balance_eth']}ETH block={p['buy_block']}")

# Step 5: Save cluster
os.makedirs("data", exist_ok=True)
with open(DATA_FILE, "w") as f:
    json.dump(profitable, f, indent=2)
print(f"\n📁 Cluster saved: {DATA_FILE} ({len(profitable)} wallets)")
