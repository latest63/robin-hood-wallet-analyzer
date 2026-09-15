#!/usr/bin/env python3
import requests, json

# DexScreener pairs endpoint works, let me get more data
r = requests.get("https://api.dexscreener.com/latest/dex/pairs/robinhood/0x4f47221d2000df55eef5b29e718cf59b95e8326a60d8f1f4e0ad07068e8b4884", timeout=10)
data = r.json()
pair = data.get("pairs",[{}])[0]
print("=== Pair Data ===")
print(json.dumps(pair, indent=2)[:2000])
