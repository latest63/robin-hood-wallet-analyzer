#!/usr/bin/env python3
"""Quick cluster build for a known active v4 pool"""
import json, subprocess, os, sys
from datetime import datetime

RPC = 'https://rpc.mainnet.chain.robinhood.com'
PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'

def rpc(method, params):
    payload = json.dumps({'jsonrpc':'2.0','method':method,'params':params,'id':1})
    r = subprocess.run(['curl','-s','-X','POST',RPC,'-H','Content-Type: application/json','-d',payload], capture_output=True, text=True, timeout=15)
    d = json.loads(r.stdout)
    return d.get('result')

ca = sys.argv[1].lower() if len(sys.argv) > 1 else None
if not ca:
    print("Usage: python3 quick_cluster.py <TOKEN_CA>")
    sys.exit(1)

# Get pool from DexScreener
import urllib.request
dex = json.loads(subprocess.run(['curl','-s',f'https://api.dexscreener.com/latest/dex/tokens/{ca}'], capture_output=True, text=True, timeout=15).stdout)
if not dex.get('pairs'):
    print("No pairs found")
    sys.exit(1)

token_name = f"{dex['pairs'][0]['baseToken']['name']} ({dex['pairs'][0]['baseToken']['symbol']})"
v4 = next((p for p in dex['pairs'] if 'v4' in p.get('labels',[])), None)
v3 = next((p for p in dex['pairs'] if 'v3' in p.get('labels',[])), None)

block = int(rpc('eth_blockNumber', []), 16)
print(f'Token: {token_name}')
print(f'Block: {block}')

buyers = {}

if v4:
    pool_id = v4['pairAddress']
    logs = rpc('eth_getLogs', [{'fromBlock': hex(block-1000), 'toBlock': hex(block), 'address': PM, 'topics': [None, pool_id]}])
    print(f'v4 swaps: {len(logs) if logs else 0}')
    
    if logs:
        seen = set()
        for l in logs:
            tx = l['transactionHash']
            if tx in seen:
                continue
            seen.add(tx)
            td = rpc('eth_getTransactionByHash', [tx])
            if not td or not td.get('from'):
                continue
            frm = td['from'].lower()
            val = int(td.get('value','0x0'),16) / 1e18
            blk = int(l['blockNumber'],16)
            if frm not in buyers:
                buyers[frm] = {'block': blk, 'value': val, 'swaps': 1}
            else:
                buyers[frm]['swaps'] += 1
                buyers[frm]['value'] += val

if not buyers and v3:
    pair = v3['pairAddress']
    code = rpc('eth_getCode', [pair, 'latest'])
    if code and code != '0x' and len(code) > 4:
        v3_swap = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
        logs = rpc('eth_getLogs', [{'fromBlock': hex(block-100000), 'toBlock': hex(block), 'address': pair, 'topics': [v3_swap]}])
        print(f'v3 swaps: {len(logs) if logs else 0}')
        
        if logs:
            seen = set()
            for l in logs:
                tx = l['transactionHash']
                if tx in seen:
                    continue
                seen.add(tx)
                td = rpc('eth_getTransactionByHash', [tx])
                if not td or not td.get('from'):
                    continue
                frm = td['from'].lower()
                val = int(td.get('value','0x0'),16) / 1e18
                blk = int(l['blockNumber'],16)
                if frm not in buyers:
                    buyers[frm] = {'block': blk, 'value': val, 'swaps': 1}
                else:
                    buyers[frm]['swaps'] += 1
                    buyers[frm]['value'] += val

print(f'Unique buyers: {len(buyers)}')

# Filter EOAs
profitable = {}
count = 0
for addr, data in buyers.items():
    code = rpc('eth_getCode', [addr, 'latest'])
    if code and code != '0x' and len(code) > 4:
        continue
    r_nonce = rpc('eth_getTransactionCount', [addr, 'latest']); nonce = int(r_nonce, 16) if r_nonce else 0
    if nonce < 3:
        continue
    r_eth = rpc('eth_getBalance', [addr, 'latest']); eth = int(r_eth, 16) / 1e18 if r_eth else 0
    score = data['swaps'] * 20 + min(nonce, 100) + min(int(eth * 10), 50)
    profitable[addr] = {**data, 'nonce': nonce, 'eth': eth, 'score': score}
    count += 1
    if count % 10 == 0:
        print(f'  Checked {count}...')

print(f'Profitable EOAs: {len(profitable)}')

# Save
os.makedirs(os.path.expanduser('~/.hermes/scripts/cluster-signal/data'), exist_ok=True)
cluster_path = os.path.expanduser('~/.hermes/scripts/cluster-signal/data/cluster.json')
cluster = {
    'token': ca,
    'token_name': token_name,
    'created_at': datetime.now().isoformat(),
    'wallets': {
        a: {
            'block': d['block'],
            'swaps': d['swaps'],
            'value': d['value'],
            'nonce': d['nonce'],
            'eth': d['eth'],
            'score': d['score'],
            'last_alert': 0
        } for a, d in profitable.items()
    }
}

with open(cluster_path, 'w') as f:
    json.dump(cluster, f, indent=2)

print(f'\nCluster: {len(cluster["wallets"])} wallets')
print('\nTop 10:')
for i, (a, d) in enumerate(sorted(cluster['wallets'].items(), key=lambda x: x[1]['score'], reverse=True)[:10]):
    print(f'  {i+1}. {a}  score:{d["score"]}  swaps:{d["swaps"]}  nonce:{d["nonce"]}  eth:{d["eth"]:.2f}')

print(f'\nNext: python3 cluster_builder.py monitor <webhook_url>')
