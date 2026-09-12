#!/usr/bin/env python3
"""Test RPC endpoints for token transfers"""
import json
import urllib.request
import ssl

endpoints = [
    "https://rpc.mainnet.chain.robinhood.com",
    "https://rpc.rockx.com/robinhood"
]

TOKEN_CONTRACT="0x385f4f8ae47651ce5f58f5265395a669f8281e18"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
deploy_block = 53946846

for rpc_url in endpoints:
    print(f"\n=== Testing {rpc_url} ===")
    
    # Test basic connection
    payload = {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(rpc_url, data=data, headers={'Content-Type': 'application/json'})
    
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            result = json.loads(resp.read().decode())
            print(f"Block number: {result.get('result', 'N/A')}")
    except Exception as e:
        print(f"Error: {e}")
        
    # Test eth_getLogs for small range
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_getLogs",
        "params": [{
            "fromBlock": hex(deploy_block),
            "toBlock": hex(deploy_block + 5),
            "address": TOKEN_CONTRACT,
            "topics": [TRANSFER_TOPIC]
        }],
        "id": 1
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(rpc_url, data=data, headers={'Content-Type': 'application/json'})
    
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            result = json.loads(resp.read().decode())
            logs = result.get('result', [])
            print(f"Logs found: {len(logs)}")
            if logs:
                print(f"First log from: 0x{logs[0]['topics'][1][26:].lower()}")
                print(f"First log to:   0x{logs[0]['topics'][2][26:].lower()}")
    except Exception as e:
        print(f"Logs error: {e}")
