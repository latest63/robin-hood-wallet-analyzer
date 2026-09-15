#!/usr/bin/env python3
import requests, json

TOKEN = "0xa58B60e1c11f5669A36C9A65c27B38b2002Be7D4"

# DexScreener top traders
print("=== DexScreener Pairs ===")
r = requests.get(f"https://api.dexscreener.com/latest/dex/tokens/{TOKEN}", timeout=10)
data = r.json()
pairs = data.get("pairs", [])
if pairs:
    p = pairs[0]
    print(f"Price: ${p.get('priceUsd','?')}")
    print(f"MC: {p.get('marketCap','?')}")
    print(f"Txns 24h: {p.get('txns',{}).get('h24',{})}")

# DexScreener has a traders endpoint?
print("\n=== Trying DexScreener traders ===")
urls = [
    f"https://api.dexscreener.com/latest/dex/trades/{pairs[0]['pairAddress']}" if pairs else None,
    f"https://api.dexscreener.com/orders/v1/robinhood/{TOKEN}",
    f"https://api.dexscreener.com/latest/dex/pairs/robinhood/{pairs[0]['pairAddress']}" if pairs else None,
]
for url in urls:
    if not url:
        continue
    r = requests.get(url, timeout=10)
    print(f"  {url[:80]}... => {r.status_code}")
    if r.status_code == 200:
        try:
            print(json.dumps(r.json(), indent=2)[:300])
        except:
            print(f"  Text: {r.text[:100]}")

# Try Cielo finance
print("\n=== Cielo ===")
cielo_urls = [
    "https://api.cielo.finance/api/v1/pnl/" + TOKEN,
    "https://feed-api.cielo.finance/api/v1/pnl/" + TOKEN,
]
for url in cielo_urls:
    r = requests.get(url, timeout=10, headers={"User-Agent":"Mozilla/5.0"})
    print(f"  {url} => {r.status_code}")
    if r.status_code == 200:
        try:
            print(json.dumps(r.json(), indent=2)[:300])
        except:
            print(f"  Text: {r.text[:200]}")

# Try GMGN with various user agents and endpoints
print("\n=== GMGN ===")
gmgn_urls = [
    f"https://gmgn.ai/defi/quotation/v1/tokens/token_info/{TOKEN}",
    f"https://gmgn.ai/defi/quotation/v1/rank/smartmoney/buy?token={TOKEN}&limit=20&orderby=profit&direction=desc",
    f"https://gmgn.ai/api/v1/smartmoney/token/{TOKEN}?limit=20",
]
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Referer": "https://gmgn.ai/",
    "Origin": "https://gmgn.ai"
}
for url in gmgn_urls:
    r = requests.get(url, timeout=10, headers=headers)
    print(f"  {url[:80]}... => {r.status_code}")
    if r.status_code == 200:
        try:
            print(json.dumps(r.json(), indent=2)[:500])
        except:
            print(f"  Text: {r.text[:200]}")
