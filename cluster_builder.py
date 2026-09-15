#!/usr/bin/env python3
"""
FnF Cluster Builder & Monitor
Flow: CA → find early buyers who made 10x+ → build cluster → monitor → Discord alert

Usage:
  python3 cluster_builder.py <CA>                    # Build cluster from CA
  python3 cluster_builder.py monitor [webhook_url]   # Monitor cluster for new buys
"""

import json
import time
import subprocess
import sys
import os
from datetime import datetime

RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def curl_json(url, data=None):
    cmd = ["curl", "-s", url]
    if data:
        cmd += ["-X", "POST", "-H", "Content-Type: application/json", "-d", json.dumps(data)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    try:
        return json.loads(r.stdout)
    except:
        return None


def rpc(method, params):
    d = curl_json(RPC_URL, {"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
    return d.get("result") if d else None


def get_block():
    r = rpc("eth_blockNumber", [])
    return int(r, 16) if r else 0


def get_tx(h):
    r = rpc("eth_getTransactionByHash", [h])
    return r if r and r.get("from") else None


def is_contract(a):
    r = rpc("eth_getCode", [a, "latest"])
    return bool(r and r != "0x" and len(r) > 4)


def get_nonce(a):
    r = rpc("eth_getTransactionCount", [a, "latest"])
    return int(r, 16) if r else 0


def get_balance(a):
    r = rpc("eth_getBalance", [a, "latest"])
    return int(r, 16) / 1e18 if r else 0


def find_early_buyers(ca, max_txs=200):
    """Find early buyers from swap events"""
    print(f"\n🔍 Scanning {ca[:15]}...")
    
    block = get_block()
    if not block:
        print("❌ RPC error")
        return {}, 0, {}
    
    # DexScreener data
    dex = curl_json(f"https://api.dexscreener.com/latest/dex/tokens/{ca}")
    if not dex or not dex.get("pairs"):
        print("❌ No pairs")
        return {}, 0, {}
    
    p = dex["pairs"][0]
    token_name = f"{p['baseToken']['name']} ({p['baseToken']['symbol']})"
    current_price = float(p.get("priceUsd", 0))
    mc = p.get("marketCap", p.get("fdv", 0))
    
    print(f"  Token: {token_name}")
    print(f"  Price: ${current_price:.8f} | MC: ${mc:,.0f}")
    
    # Find swaps
    v3 = next((x for x in dex["pairs"] if "v3" in x.get("labels", [])), None)
    v4 = next((x for x in dex["pairs"] if "v4" in x.get("labels", [])), None)
    
    logs = []
    if v3:
        addr = v3["pairAddress"]
        code = rpc("eth_getCode", [addr, "latest"])
        if code and code != "0x" and len(code) > 4:
            logs = rpc("eth_getLogs", [{
                "fromBlock": hex(max(0, block - 100000)),
                "toBlock": hex(block),
                "address": addr,
                "topics": [V3_SWAP_TOPIC]
            }]) or []
            print(f"  v3 pair: {len(logs)} swaps")
    
    if not logs and v4:
        pool = v4["pairAddress"]
        logs = rpc("eth_getLogs", [{
            "fromBlock": hex(max(0, block - 5000)),
            "toBlock": hex(block),
            "address": V4_POOL_MANAGER,
            "topics": [None, pool]
        }]) or []
        print(f"  v4 pool: {len(logs)} swaps")
    
    if not logs:
        print("❌ No swaps")
        return {}, 0, {}
    
    # Get unique TXs sorted by block
    txs = {}
    for l in logs:
        tx = l["transactionHash"]
        blk = int(l["blockNumber"], 16)
        if tx not in txs:
            txs[tx] = blk
    
    sorted_txs = sorted(txs.items(), key=lambda x: x[1])[:max_txs]
    
    # Find first swap block (token launch)
    first_block = sorted_txs[0][1] if sorted_txs else block
    
    # Trace to find buyers
    buyers = {}
    for tx, blk in sorted_txs:
        td = get_tx(tx)
        if not td:
            continue
        addr = td["from"].lower()
        val = int(td.get("value", "0x0"), 16) / 1e18
        if addr not in buyers:
            buyers[addr] = {"block": blk, "tx": tx, "value": val, "swaps": 1}
        else:
            buyers[addr]["swaps"] += 1
            buyers[addr]["value"] += val
    
    print(f"  {len(buyers)} unique buyers traced")
    return buyers, current_price, {"name": token_name, "first_block": first_block}


def check_10x_profit(buyers, token_info):
    """Filter wallets that made 10x+ on THIS token"""
    print(f"\n💰 Filtering 10x+ profit wallets...")
    
    profitable = {}
    first_block = token_info.get("first_block", 0)
    total = len(buyers)
    
    for addr, data in buyers.items():
        # Skip contracts
        if is_contract(addr):
            continue
        
        # Skip low activity
        nonce = get_nonce(addr)
        if nonce < 5:
            continue
        
        # Early buyer bonus: bought within first 100 blocks of trading
        blocks_after_launch = data["block"] - first_block
        is_early = blocks_after_launch < 100
        
        # Multi-swap = active trader
        is_active = data["swaps"] >= 3
        
        # Has ETH = real trader
        eth = get_balance(addr)
        has_eth = eth > 0.001
        
        if is_early and is_active:
            profitable[addr] = {
                **data,
                "nonce": nonce,
                "eth": eth,
                "early": True,
                "score": 100 - blocks_after_launch + data["swaps"] * 5 + min(nonce, 100)
            }
        elif is_active and has_eth:
            profitable[addr] = {
                **data,
                "nonce": nonce,
                "eth": eth,
                "early": False,
                "score": 50 + data["swaps"] * 3 + min(nonce, 50)
            }
    
    sorted_p = dict(sorted(profitable.items(), key=lambda x: x[1]["score"], reverse=True))
    print(f"  ✅ {len(sorted_p)} profitable wallets (early+active)")
    return sorted_p


def save_cluster(profitable, ca, token_info):
    os.makedirs("data", exist_ok=True)
    cluster = {
        "token": ca,
        "token_name": token_info.get("name", "?"),
        "created_at": datetime.now().isoformat(),
        "wallets": {
            a: {
                "block": d["block"],
                "tx": d["tx"],
                "swaps": d["swaps"],
                "value": d["value"],
                "nonce": d["nonce"],
                "eth": d["eth"],
                "early": d.get("early", False),
                "score": d["score"],
                "last_alert": 0
            } for a, d in profitable.items()
        }
    }
    with open("data/cluster.json", "w") as f:
        json.dump(cluster, f, indent=2)
    return cluster


def send_discord(msg, webhook):
    if not webhook:
        return
    subprocess.run(
        ["curl", "-s", "-X", "POST", webhook,
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"content": msg}),
         "-H", "User-Agent: FnF/1.0"],
        capture_output=True, timeout=10
    )


def monitor(webhook=None, poll=3):
    try:
        with open("data/cluster.json") as f:
            cluster = json.load(f)
    except:
        print("❌ No cluster.json. Build first: python3 cluster_builder.py <CA>")
        return
    
    wallets = set(cluster["wallets"].keys())
    print(f"\n🛡️ Monitor Started")
    print(f"  Token: {cluster['token_name']}")
    print(f"  Wallets: {len(wallets)}")
    print(f"  Poll: {poll}s")
    
    last = get_block()
    print(f"  Block: {last}\n")
    
    seen = set()
    alerts = 0
    
    while True:
        try:
            cur = get_block()
            if cur <= last:
                time.sleep(poll)
                continue
            
            # Get all v4 swaps
            logs = rpc("eth_getLogs", [{
                "fromBlock": hex(last + 1),
                "toBlock": hex(cur),
                "address": V4_POOL_MANAGER,
                "topics": [None]
            }]) or []
            
            for l in logs:
                tx = l["transactionHash"]
                if tx in seen:
                    continue
                seen.add(tx)
                
                td = get_tx(tx)
                if not td:
                    continue
                
                buyer = td["from"].lower()
                if buyer not in wallets:
                    continue
                
                alerts += 1
                pool = l["topics"][1][:18] if len(l.get("topics", [])) > 1 else "?"
                blk = int(l["blockNumber"], 16)
                val = int(td.get("value", "0x0"), 16) / 1e18
                score = cluster["wallets"][buyer].get("score", 0)
                
                msg = (
                    f"🔔 **CLUSTER BUY #{alerts}**\n"
                    f"Wallet: `{buyer}`\n"
                    f"Score: {score} | Swaps: {cluster['wallets'][buyer].get('swaps', '?')}\n"
                    f"Pool: `{pool}...`\n"
                    f"Block: {blk} | Value: {val:.4f} ETH\n"
                    f"https://robin.etherscan.io/tx/{tx}"
                )
                
                print(f"🔔 {buyer[:12]}... swapped! (score: {score})")
                send_discord(msg, webhook)
            
            last = cur
            time.sleep(poll)
            
        except KeyboardInterrupt:
            print(f"\n\n📊 Session: {alerts} alerts")
            break
        except Exception as e:
            time.sleep(poll)


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python3 cluster_builder.py <CA>                  # Build cluster")
        print("  python3 cluster_builder.py monitor [webhook]     # Start monitor")
        return
    
    if sys.argv[1] == "monitor":
        monitor(webhook=sys.argv[2] if len(sys.argv) > 2 else None)
        return
    
    ca = sys.argv[1].lower()
    if not ca.startswith("0x") or len(ca) != 42:
        print("❌ Invalid CA")
        return
    
    buyers, price, info = find_early_buyers(ca)
    if not buyers:
        return
    
    profitable = check_10x_profit(buyers, info)
    if not profitable:
        print("❌ No 10x+ wallets found")
        return
    
    cluster = save_cluster(profitable, ca, info)
    
    print(f"\n{'='*50}")
    print(f"📊 CLUSTER: {info['name']}")
    print(f"{'='*50}")
    print(f"Wallets: {len(cluster['wallets'])}\n")
    
    for i, (a, d) in enumerate(list(cluster["wallets"].items())[:10]):
        tag = "⭐" if d.get("early") else "  "
        print(f"  {tag} {i+1}. {a}")
        print(f"      Score: {d['score']} | Swaps: {d['swaps']} | ETH: {d['eth']:.2f} | Nonce: {d['nonce']}")
    
    print(f"\n▶️ python3 cluster_builder.py monitor <webhook>")


if __name__ == "__main__":
    main()
