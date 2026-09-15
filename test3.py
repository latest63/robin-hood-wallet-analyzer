#!/usr/bin/env python3
import requests, json

TOKEN="0xa5...n
# Try Robin Hood explorer API
print("=== Robin Hood Explorer ===")
explorer_urls = [
    f"https://explorer.mainnet.chain.robinhood.com/api/v2/transactions?token={TOKEN}",
    f"https://explorer.mainnet.chain.robinhood.com/api?module=token&action=tokenholderlist&contractaddress={TOKEN}",
    f"https://api-explorer.mainnet.chain.robinhood.com/api/v2/tokens/{TOKEN}/holders",
]

for url in explorer_urls:
    try:
        r = requests.get(url, timeout=10, headers={"User-Agent":"Mozilla/5.0"})
        print(f"URL: {url}")
        print(f"  Status: {r.status_code}")
        if r.status_code == 200:
            try:
                data = r.json()
                print(json.dumps(data, indent=2)[:500])
            except:
                print(f"  Text: {r.text[:200]}")
    except Exception as e:
        print(f"  Error: {e}")

# Try DexScreener new endpoints
print("\n=== DexScreener New ===")
ds_urls = [
    f"https://api.dexscreener.com/latest/dex/tokens/{TOKEN}",
]
for url in ds_urls:
    r = requests.get(url, timeout=10)
    print(f"URL: {url[:60]}... => {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        if isinstance(data, dict) and data.get("pairs"):
            p = data["pairs"][0]
            print(f"  Price: ${p.get('priceUsd','?')}")
            # Check for any trader data
            for key in p.keys():
                if key not in ["chainId","dexId","url","pairAddress","labels","baseToken","quoteToken","priceNative","priceUsd","txns","volume","priceChange","liquidity","fdv","marketCap","pairCreatedAt","info","boosts"]:
                    print(f"  Extra key: {key} = {p[key]}")
