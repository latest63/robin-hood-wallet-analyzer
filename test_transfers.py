#!/usr/bin/env python3
"""Fetch token transfers from Blockscout Pro API"""
import json
import urllib.request

API_KEY = "proapi_TlyrBoiYCLN7zzVgNxYX6VSltLuOk3mpDMaiZCJfa9ApaYdZRZD4tPJgNjmc0eZ0_bujSGJ"
TOKEN_CONTRACT = "0x385f4f8ae47651ce5f58f5265395a669f8281e18"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

def api_call(endpoint, params=None):
    url = f"https://api.blockscout.com/api/v2/{endpoint}"
    if params:
        query = "&".join(f"{k}={v}" for k, v in params.items())
        url += f"?{query}"
    
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"error": str(e)}

# Get token transfers sorted ascending (oldest first)
print("Fetching token transfers via Blockscout Pro API...")
result = api_call("token-transfers", {
    "token_address": TOKEN_CONTRACT,
    "limit": 100,
    "sort": "asc"
})

if 'error' in result:
    print(f"Error: {result}")
else:
    print(f"\nFound {len(result)} transfers")
    print("\nFirst 20 transfers:")
    for i, t in enumerate(result[:20]):
        print(f"\n[{i+1}] TX: {t.get('transaction_hash')}")
        print(f"    From: {t.get('sender_address')}")
        print(f"    To:   {t.get('receiver_address')}")
        val = int(t.get('value', 0)) / 1e18
        print(f"    Value: {val:.2f}")
        print(f"    Block: {t.get('block_number')}")
