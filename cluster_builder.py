#!/usr/bin/env python3
"""
FnF Cluster Builder & Monitor
Flow: CA → find early buyers → filter profitable → build cluster → monitor → Discord alert
"""

import json
import time
import subprocess
import sys
import os
from datetime import datetime

RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")

# v4 PoolManager on Robin Hood Chain
V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"

# Event topics
V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"


def curl_json(url, data=None):
    """Make HTTP request using curl"""
    if data:
        result = subprocess.run(
            ["curl", "-s", "-X", "POST", url,
             "-H", "Content-Type: application/json", "-d", json.dumps(data)],
            capture_output=True, text=True, timeout=15
        )
    else:
        result = subprocess.run(
            ["curl", "-s", url],
            capture_output=True, text=True, timeout=15
        )
    try:
        return json.loads(result.stdout)
    except:
        return None


def rpc(method, params):
    """Execute RPC call"""
    d = curl_json(RPC_URL, {"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
    if d and "result" in d:
        return d["result"]
    return None


def get_block():
    r = rpc("eth_blockNumber", [])
    return int(r, 16) if r else 0


def get_tx(tx_hash):
    r = rpc("eth_getTransactionByHash", [tx_hash])
    return r if r and r.get("from") else None


def is_contract(addr):
    r = rpc("eth_getCode", [addr, "latest"])
    return bool(r and r != "0x" and len(r) > 4)


def get_eth_balance(addr):
    r = rpc("eth_getBalance", [addr, "latest"])
    return int(r, 16) / 1e18 if r else 0


def get_nonce(addr):
    r = rpc("eth_getTransactionCount", [addr, "latest"])
    return int(r, 16) if r else 0


def find_early_buyers(ca, max_txs=200):
    """Find early buyers of a token from DEX swaps"""
    print(f"\n🔍 Scanning {ca[:15]}...")
    
    current_block = get_block()
    if not current_block:
        print("❌ RPC error")
        return {}
    
    # Get pairs from DexScreener
    dex = curl_json(f"https://api.dexscreener.com/latest/dex/tokens/{ca}")
    if not dex or not dex.get("pairs"):
        print("❌ No pairs on DexScreener")
        return {}
    
    pairs = dex["pairs"]
    token_name = pairs[0].get("baseToken", {}).get("name", "?")
    token_symbol = pairs[0].get("baseToken", {}).get("symbol", "?")
    current_price = float(pairs[0].get("priceUsd", 0))
    mc = pairs[0].get("marketCap", pairs[0].get("fdv", 0))
    liq = pairs[0].get("liquidity", {}).get("usd", 0)
    
    print(f"  Token: {token_name} ({token_symbol})")
    print(f"  Price: ${current_price:.8f} | MC: ${mc:,.0f} | Liq: ${liq:,.0f}")
    
    # Find v3 pair first (better historical data)
    v3_pair = next((p for p in pairs if "v3" in p.get("labels", [])), None)
    v4_pair = next((p for p in pairs if "v4" in p.get("labels", [])), None)
    
    swap_logs = []
    scan_type = ""
    
    if v3_pair:
        pair_addr = v3_pair["pairAddress"]
        code = rpc("eth_getCode", [pair_addr, "latest"])
        if code and code != "0x" and len(code) > 4:
            scan_type = "v3"
            # Search wider range for v3
            from_block = max(0, current_block - 100000)
            swap_logs = rpc("eth_getLogs", [{
                "fromBlock": hex(from_block),
                "toBlock": hex(current_block),
                "address": pair_addr,
                "topics": [V3_SWAP_TOPIC]
            }]) or []
            print(f"  v3 pair: {pair_addr[:15]}... | {len(swap_logs)} swaps")
    
    if not swap_logs and v4_pair:
        pool_id = v4_pair["pairAddress"]
        scan_type = "v4"
        from_block = max(0, current_block - 5000)
        swap_logs = rpc("eth_getLogs", [{
            "fromBlock": hex(from_block),
            "toBlock": hex(current_block),
            "address": V4_POOL_MANAGER,
            "topics": [None, pool_id]
        }]) or []
        print(f"  v4 pool: {pool_id[:15]}... | {len(swap_logs)} swaps")
    
    if not swap_logs:
        print("❌ No swap events found")
        return {}
    
    # Get unique TXs sorted by block
    tx_blocks = {}
    for log in swap_logs:
        tx = log["transactionHash"]
        blk = int(log["blockNumber"], 16)
        if tx not in tx_blocks or blk < tx_blocks[tx]:
            tx_blocks[tx] = blk
    
    sorted_txs = sorted(tx_blocks.items(), key=lambda x: x[1])
    print(f"  {len(sorted_txs)} unique TXs to trace")
    
    # Trace TXs to find real buyers
    wallet_map = {}
    checked = 0
    
    for tx, block in sorted_txs[:max_txs]:
        tx_data = get_tx(tx)
        if not tx_data:
            continue
        
        buyer = tx_data["from"].lower()
        value_eth = int(tx_data.get("value", "0x0"), 16) / 1e18
        
        if buyer not in wallet_map:
            wallet_map[buyer] = {
                "first_block": block,
                "first_tx": tx,
                "total_value_eth": value_eth,
                "swap_count": 1
            }
        else:
            wallet_map[buyer]["swap_count"] += 1
            wallet_map[buyer]["total_value_eth"] += value_eth
        
        checked += 1
        if checked % 20 == 0:
            print(f"  ⏳ {checked}/{min(len(sorted_txs), max_txs)} traced...")
    
    print(f"  ✅ {len(wallet_map)} unique buyers found")
    return wallet_map


def filter_profitable(buyers, min_swaps=3, min_eth=0.001):
    """Filter for likely profitable wallets - EOAs with activity"""
    print(f"\n💰 Filtering profitable wallets...")
    
    profitable = {}
    checked = 0
    total = len(buyers)
    
    for addr, data in buyers.items():
        checked += 1
        
        # Skip if too few swaps (not a real trader)
        if data["swap_count"] < min_swaps:
            continue
        
        # Skip if no ETH spent (router/contract)
        if data["total_value_eth"] < min_eth:
            continue
        
        # Check if EOA (not contract)
        if is_contract(addr):
            continue
        
        # Get nonce (activity level)
        nonce = get_nonce(addr)
        if nonce < 5:  # Too new
            continue
        
        # Get ETH balance
        balance = get_eth_balance(addr)
        
        profitable[addr] = {
            **data,
            "nonce": nonce,
            "eth_balance": balance,
            "score": data["swap_count"] * 10 + min(balance * 100, 50) + min(nonce, 50)
        }
        
        if checked % 10 == 0:
            print(f"  ⏳ {checked}/{total} checked...")
    
    # Sort by score
    sorted_profitable = dict(sorted(profitable.items(), key=lambda x: x[1]["score"], reverse=True))
    
    print(f"  ✅ {len(sorted_profitable)} profitable wallets found")
    return sorted_profitable


def build_cluster(profitable, ca, token_name=""):
    """Build cluster from profitable wallets"""
    cluster = {
        "token": ca,
        "token_name": token_name,
        "created_at": datetime.now().isoformat(),
        "wallets": {}
    }
    
    for addr, data in profitable.items():
        cluster["wallets"][addr] = {
            "first_seen_block": data["first_block"],
            "first_tx": data["first_tx"],
            "swap_count": data["swap_count"],
            "total_value_eth": data["total_value_eth"],
            "nonce": data["nonce"],
            "eth_balance": data["eth_balance"],
            "score": data["score"],
            "last_alert_block": 0
        }
    
    return cluster


def save_cluster(cluster, filename="data/cluster.json"):
    """Save cluster to file"""
    os.makedirs(os.path.dirname(filename), exist_ok=True)
    with open(filename, "w") as f:
        json.dump(cluster, f, indent=2)
    print(f"\n💾 Cluster saved: {filename}")
    return filename


def load_cluster(filename="data/cluster.json"):
    """Load cluster from file"""
    try:
        with open(filename) as f:
            return json.load(f)
    except:
        return None


def send_discord(message, webhook=None):
    """Send Discord webhook alert"""
    webhook = webhook or DISCORD_WEBHOOK
    if not webhook:
        print(f"  ⚠️ No webhook configured, skipping alert")
        return False
    
    payload = json.dumps({"content": message})
    result = subprocess.run(
        ["curl", "-s", "-X", "POST", webhook,
         "-H", "Content-Type: application/json",
         "-d", payload,
         "-H", "User-Agent: FnF-Radar/1.0"],
        capture_output=True, text=True, timeout=10
    )
    return result.returncode == 0


def resolve_pool_token(pool_id):
    """Try to resolve what token a v4 pool is swapping"""
    # This would need to decode the pool ID or check the swap data
    # For now return unknown
    return "Unknown"


def monitor_cluster(cluster_file="data/cluster.json", webhook=None, poll_seconds=3):
    """Monitor cluster wallets for new buys"""
    cluster = load_cluster(cluster_file)
    if not cluster:
        print(f"❌ No cluster found at {cluster_file}")
        return
    
    wallets = set(cluster["wallets"].keys())
    token_name = cluster.get("token_name", "?")
    
    print(f"\n🛡️ Cluster Monitor Started")
    print(f"  Token: {token_name}")
    print(f"  Wallets: {len(wallets)}")
    print(f"  Poll: {poll_seconds}s")
    print(f"  Webhook: {'ON' if webhook else 'OFF'}")
    
    last_block = get_block()
    print(f"  Block: {last_block}")
    print(f"\n⏳ Watching for cluster activity...\n")
    
    seen_txs = set()
    alert_count = 0
    
    while True:
        try:
            current_block = get_block()
            if current_block <= last_block:
                time.sleep(poll_seconds)
                continue
            
            # Get ALL v4 swaps since last block
            swap_logs = rpc("eth_getLogs", [{
                "fromBlock": hex(last_block + 1),
                "toBlock": hex(current_block),
                "address": V4_POOL_MANAGER,
                "topics": [None]  # All pools
            }]) or []
            
            new_txs = 0
            for log in swap_logs:
                tx = log["transactionHash"]
                if tx in seen_txs:
                    continue
                seen_txs.add(tx)
                new_txs += 1
                
                # Get buyer
                tx_data = get_tx(tx)
                if not tx_data:
                    continue
                
                buyer = tx_data["from"].lower()
                if buyer not in wallets:
                    continue
                
                # ALERT! Cluster wallet just bought!
                alert_count += 1
                pool_id = log["topics"][1] if len(log.get("topics", [])) > 1 else "?"
                block_num = int(log["blockNumber"], 16)
                value_eth = int(tx_data.get("value", "0x0"), 16) / 1e18
                
                msg = (
                    f"🚨 **CLUSTER BUY #{alert_count}**\n"
                    f"Wallet: `{buyer}`\n"
                    f"Pool: `{pool_id[:18]}...`\n"
                    f"Block: {block_num}\n"
                    f"Value: {value_eth:.4f} ETH\n"
                    f"TX: https://robin.etherscan.io/tx/{tx}\n"
                    f"Wallet score: {cluster['wallets'][buyer].get('score', '?')}"
                )
                
                print(f"🚨 ALERT: {buyer[:12]}... just swapped! (score: {cluster['wallets'][buyer].get('score', '?')})")
                send_discord(msg, webhook)
                
                # Update last alert block
                cluster["wallets"][buyer]["last_alert_block"] = block_num
            
            if new_txs > 0 and alert_count == 0:
                # Activity but no cluster hits
                pass
            
            last_block = current_block
            time.sleep(poll_seconds)
            
        except KeyboardInterrupt:
            print(f"\n\n📊 Session: {alert_count} alerts sent")
            save_cluster(cluster, cluster_file)
            print("💾 Cluster state saved")
            break
        except Exception as e:
            print(f"  ⚠️ {e}")
            time.sleep(poll_seconds)


def main():
    if len(sys.argv) < 2:
        print("FnF Cluster Builder & Monitor")
        print("=" * 40)
        print()
        print("Build cluster from CA:")
        print("  python cluster_builder.py <CA>")
        print()
        print("Start monitoring:")
        print("  python cluster_builder.py monitor [webhook_url]")
        print()
        return
    
    cmd = sys.argv[1]
    
    if cmd == "monitor":
        webhook = sys.argv[2] if len(sys.argv) > 2 else DISCORD_WEBHOOK
        monitor_cluster(webhook=webhook)
        return
    
    # Build cluster from CA
    ca = cmd.lower()
    if not ca.startswith("0x") or len(ca) != 42:
        print("❌ Invalid address")
        return
    
    # Step 1: Find early buyers
    buyers = find_early_buyers(ca)
    if not buyers:
        return
    
    # Step 2: Filter profitable (EOAs with activity)
    profitable = filter_profitable(buyers, min_swaps=3, min_eth=0.001)
    if not profitable:
        print("❌ No profitable wallets found")
        return
    
    # Step 3: Build cluster
    token_name = ""
    dex = curl_json(f"https://api.dexscreener.com/latest/dex/tokens/{ca}")
    if dex and dex.get("pairs"):
        token_name = f"{dex['pairs'][0]['baseToken']['name']} ({dex['pairs'][0]['baseToken']['symbol']})"
    
    cluster = build_cluster(profitable, ca, token_name)
    cluster_file = save_cluster(cluster)
    
    # Print summary
    print(f"\n{'='*50}")
    print(f"📊 CLUSTER SUMMARY: {token_name}")
    print(f"{'='*50}")
    print(f"Wallets: {len(cluster['wallets'])}")
    print()
    print("Top 10 by score:")
    for i, (addr, data) in enumerate(list(cluster["wallets"].items())[:10]):
        print(f"  {i+1}. {addr}")
        print(f"     Score: {data['score']} | Swaps: {data['swap_count']} | ETH: {data['eth_balance']:.2f} | Nonce: {data['nonce']}")
    
    print(f"\n▶️ Next: python cluster_builder.py monitor <webhook_url>")


if __name__ == "__main__":
    main()
