#!/usr/bin/env python3
"""
GMGN Profitable Cluster Builder
Uses GMGN API to find profitable traders on a token, builds cluster, monitors

Usage:
  python3 gmgn_cluster.py <TOKEN_CA>                    # Build cluster
  python3 gmgn_cluster.py <TOKEN_CA> monitor            # Build + monitor
  python3 gmgn_cluster.py <TOKEN_CA> monitor <webhook>  # Build + monitor + Discord
"""
import sys
import json
import os
import subprocess
import time
from datetime import datetime

TOKEN = sys.argv[1] if len(sys.argv) > 1 else None
if not TOKEN:
    print("Usage: python3 gmgn_cluster.py <TOKEN_CA> [monitor] [webhook]")
    sys.exit(1)

MODE = sys.argv[2] if len(sys.argv) > 2 else "build"
WEBHOOK = sys.argv[3] if len(sys.argv) > 3 else None
CHAIN = "robinhood"
DATA_FILE = "data/cluster.json"
MIN_PROFIT = 1000  # Minimum $1000 profit
POLL_SECONDS = 30

def gmgn_cmd(args):
    """Run gmgn-cli command and return JSON"""
    cmd = ["gmgn-cli"] + args
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            return json.loads(result.stdout)
    except Exception as e:
        print(f"  Error: {e}")
    return None

def send_discord(wallet, token_name, profit, pnl):
    if not WEBHOOK:
        return
    try:
        import requests
        payload = {
            "embeds": [{
                "title": f"💰 Profitable Trader Alert — {token_name}",
                "description": f"**Wallet:** [`{wallet[:10]}...{wallet[-6:]}`](https://explorer.mainnet.chain.robinhood.com/address/{wallet})\n**Profit:** ${profit:,.0f}\n**PnL:** {pnl*100:.1f}%",
                "color": 0x00ff00,
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "footer": {"text": "GMGN Cluster Monitor • robinhood chain"}
            }]
        }
        requests.post(WEBHOOK, json=payload, timeout=10,
                      headers={"User-Agent": "ClusterMonitor/1.0"})
    except:
        pass

# ─── STEP 1: Get token info ───
print(f"🔍 Scanning {TOKEN[:10]}...")
token_info = gmgn_cmd(["token", "info", "--chain", CHAIN, "--address", TOKEN, "--raw"])
if not token_info:
    print("❌ Token not found on GMGN")
    sys.exit(1)

name = token_info.get("name", "?")
symbol = token_info.get("symbol", "?")
price = token_info.get("price", {}).get("price", "?")
holder_count = token_info.get("holder_count", 0)

print(f"  Token: {name} ({symbol})")
print(f"  Price: ${price}")
print(f"  Holders: {holder_count:,}")

# ─── STEP 2: Get top traders by profit ───
print(f"\n💰 Finding profitable traders...")
traders = gmgn_cmd([
    "token", "traders",
    "--chain", CHAIN,
    "--address", TOKEN,
    "--order-by", "profit",
    "--direction", "desc",
    "--limit", "50",
    "--raw"
])

if not traders or not traders.get("list"):
    print("❌ No traders found")
    sys.exit(1)

trader_list = traders["list"]
print(f"  Found {len(trader_list)} traders")

# ─── STEP 3: Filter profitable wallets ───
profitable = []
for t in trader_list:
    profit = t.get("profit", 0)
    realized_pnl = t.get("realized_pnl", 0)
    wallet = t.get("address", "")
    tags = t.get("tags", [])
    
    # Skip bots and suspicious wallets
    if "sandwich_bot" in tags or "rat_trader" in tags:
        continue
    
    # Filter by profit threshold
    if profit >= MIN_PROFIT:
        profitable.append({
            "wallet": wallet,
            "profit": profit,
            "realized_pnl": realized_pnl,
            "buy_tx_count": t.get("buy_tx_count_cur", 0),
            "sell_tx_count": t.get("sell_tx_count_cur", 0),
            "balance": t.get("balance", 0),
            "usd_value": t.get("usd_value", 0),
            "tags": tags,
            "source": f"GMGN:{symbol}",
            "token": name,
            "symbol": symbol
        })

profitable.sort(key=lambda x: x["profit"], reverse=True)

print(f"\n✅ Profitable traders (>${MIN_PROFIT:,} profit): {len(profitable)}")
for p in profitable[:15]:
    print(f"  {p['wallet'][:10]}... | ${p['profit']:,.0f} profit | {p['realized_pnl']*100:.1f}% PnL | {p['buy_tx_count']} buys")

if len(profitable) > 15:
    print(f"  ... and {len(profitable) - 15} more")

# ─── STEP 4: Save cluster ───
os.makedirs("data", exist_ok=True)
with open(DATA_FILE, "w") as f:
    json.dump(profitable, f, indent=2)

print(f"\n💾 Saved: {DATA_FILE} ({len(profitable)} wallets)")

if MODE != "monitor":
    print(f"\n▶️ Monitor: python3 gmgn_cluster.py {TOKEN} monitor [webhook]")
    sys.exit(0)

# ─── STEP 5: Monitor loop (poll GMGN for new activity) ───
print(f"\n👀 Monitoring cluster (poll every {POLL_SECONDS}s)...")
if WEBHOOK:
    import requests
    print(f"  Discord → {WEBHOOK[:50]}...")
else:
    print(f"  Console alerts only")

cluster_wallets = set(p["wallet"] for p in profitable)
alert_count = 0
last_check = {}

try:
    while True:
        try:
            # For each wallet in cluster, check recent activity
            for p in profitable:
                wallet = p["wallet"]
                
                # Check wallet portfolio for new buys
                portfolio = gmgn_cmd([
                    "portfolio", "activity",
                    "--chain", CHAIN,
                    "--wallet", wallet,
                    "--raw"
                ])
                
                if portfolio and portfolio.get("list"):
                    for activity in portfolio["list"][:3]:
                        activity_id = activity.get("timestamp", "")
                        if wallet not in last_check or last_check[wallet] != activity_id:
                            last_check[wallet] = activity_id
                            
                            # Check if it's a buy
                            if activity.get("type") == "buy":
                                alert_count += 1
                                ts = datetime.now().strftime("%H:%M:%S")
                                print(f"\n🔔 [{ts}] PROFITABLE TRADER BUYING!")
                                print(f"   Wallet: {wallet}")
                                print(f"   Profit on {symbol}: ${p['profit']:,.0f}")
                                print(f"   Token: {activity.get('token_symbol', '?')}")
                                send_discord(wallet, activity.get('token_symbol', '?'), p['profit'], p['realized_pnl'])
                
                time.sleep(2)  # Rate limit between wallets
            
            time.sleep(POLL_SECONDS)

        except KeyboardInterrupt:
            raise
        except Exception as e:
            print(f"⚠️ {e}")
            time.sleep(POLL_SECONDS)

except KeyboardInterrupt:
    print(f"\n\n⏹ Stopped. {alert_count} alerts fired.")
