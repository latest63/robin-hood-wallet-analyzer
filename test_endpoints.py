#!/usr/bin/env python3
import requests, json, sys

TOKEN=*** = sys.argv[1]

print("=== DexScreener API ===")

r = requests.get("https://api.dexscreener.com/latest/dex/tokens/" + TOKEN, timeout=10)
data = r.json()
pair = data["pairs"][0]
pair_addr = pair["pairAddress"]

print("Pair: " + pair_addr[:20] + "...")
print("Price: $" + pair["priceUsd"])
print("24h txns: " + str(pair["txns"]["h24"]))

print("\n=== Checking DexScreener endpoints ===")
endpoints = [
    "https://api.dexscreener.com/latest/dex/trades/" + pair_addr,
    "https://api.dexscreener.com/latest/dex/top-traders/" + pair_addr,
    "https://api.dexscreener.com/orders/v1/robinhood/" + TOKEN,
    "https://api.dexscreener.com/token-profiles/latest/v1",
]

for url in endpoints:
    r = requests.get(url, timeout=10)
    print(url[30:60] + "... => " + str(r.status_code))
    if r.status_code == 200:
        try:
            d = r.json()
            if isinstance(d, dict):
                print("  Keys: " + str(list(d.keys())[:5]))
            elif isinstance(d, list):
                print("  List len: " + str(len(d)))
        except:
            pass
