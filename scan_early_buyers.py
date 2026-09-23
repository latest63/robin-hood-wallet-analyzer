#!/usr/bin/env python3
"""
Scan any token on Robinhood Chain for early buyers via RPC.
Usage: python3 scan_early_buyers.py <contract_address>
"""
import json
import urllib.request
import ssl
import sys
import time

_HEX = chr(48) + chr(120)
RPC_URL = "https://rpc.mainnet.chain.robinhood.com"

_TRANSFER_TOPIC = _HEX + bytes.fromhex('ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef').hex()
_POOL_MANAGER = _HEX + bytes.fromhex('8366a39cc670b4001a1121b8f6a443a643e40951').hex()
_ZERO_ADDR = _HEX + "0000000000000000000000000000000000000000"

ctx = ssl.create_default_context()


def rpc_call(method, params):
    payload = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    req = urllib.request.Request(RPC_URL, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            return json.loads(resp.read().decode()).get("result")
    except Exception as e:
        print(f"RPC error: {e}", file=sys.stderr)
        return None


def eth_hex(val):
    h = format(val, 'x')
    return _HEX + h if len(h) % 2 else _HEX + '0' + h


def main():
    if len(sys.argv) < 2:
        print(f"Usage: python3 {sys.argv[0]} <contract_address>", file=sys.stderr)
        sys.exit(1)

    raw = sys.argv[1].strip()
    TOKEN = _HEX + raw[2:] if raw.lower().startswith(_HEX) else _HEX + raw
    print(f"Token: {TOKEN}", flush=True)

    # Get current block
    block_hex = rpc_call("eth_blockNumber", []) or "0x0"
    current = int(block_hex, 16)
    
    # Scan last 500k blocks max for performance
    from_block = max(current - 500000, 69200000)
    print(f"Scanning blocks {from_block:,} to {current:,}...", flush=True)

    all_buyers = {}
    chunk_size = 10000  # Larger chunks for speed
    log_count = 0
    start_time = time.time()
    
    try:
        for start in range(from_block, current, chunk_size):
            end = min(start + chunk_size, current)
            logs = rpc_call("eth_getLogs", [{"fromBlock": eth_hex(start), "toBlock": eth_hex(end), "address": TOKEN, "topics": [_TRANSFER_TOPIC]}])
            if not logs:
                continue
            log_count += len(logs)
            
            for log in logs:
                topics = log.get("topics", [])
                if len(topics) < 3:
                    continue
                from_addr = _HEX + topics[1][26:].lower()
                to_addr = _HEX + topics[2][26:].lower()
                amount = int(log.get("data", _HEX), 16)
                block_num = int(log.get("blockNumber", "0x0"), 16)
                
                if to_addr in (_ZERO_ADDR, TOKEN.lower()):
                    continue
                if to_addr not in all_buyers:
                    all_buyers[to_addr] = {"first_block": block_num, "total_received": 0, "tx_count": 0, "sources": {}}
                all_buyers[to_addr]["total_received"] += amount
                all_buyers[to_addr]["tx_count"] += 1
                src = from_addr
                if src not in all_buyers[to_addr]["sources"]:
                    all_buyers[to_addr]["sources"][src] = 0
                all_buyers[to_addr]["sources"][src] += 1
            
            # Progress indicator
            elapsed = time.time() - start_time
            pct = (start - from_block) / (current - from_block) * 100 if current > from_block else 100
            print(f"\rProgress: {pct:.1f}% ({log_count:,} logs)", end="", flush=True)
            time.sleep(0.1)
    except KeyboardInterrupt:
        print("\nInterrupted")
    finally:
        print(f"\nScan complete in {time.time() - start_time:.1f}s\n", flush=True)

    sorted_buyers = sorted(all_buyers.items(), key=lambda x: x[1]["first_block"])
    pm_buyers = [(a, i) for a, i in sorted_buyers if _POOL_MANAGER in i["sources"]]
    pm_total = sum(i["total_received"] for _, i in pm_buyers)

    print(f"\nTotal transfers: {log_count}")
    print(f"Unique wallets: {len(sorted_buyers)}")

    if pm_buyers:
        print(f"\n=== POOLMANAGER DISTRIBUTION ({len(pm_buyers)} wallets) ===")
        print(f"Total distributed: {pm_total/1e18:,.2f}")
        print()
        for addr, info in pm_buyers[:20]:
            print(f"  {addr} | {info['total_received']/1e18:>20,.2f} | blk={info['first_block']:,}")

    print(f"\n=== TOP BUYERS (by total received) ===")
    by_amount = sorted(sorted_buyers, key=lambda x: x[1]["total_received"], reverse=True)
    for addr, info in by_amount[:20]:
        src_label = "PM" if _POOL_MANAGER in info["sources"] else ""
        print(f"  {addr} | {info['total_received']/1e18:>20,.2f} | txns={info['tx_count']} {src_label}")

    print(f"\n=== EARLY BUYERS (by block) ===")
    for addr, info in sorted_buyers[:20]:
        src_label = "PM" if _POOL_MANAGER in info["sources"] else ""
        print(f"  {addr} | {info['total_received']/1e18:>20,.2f} | blk={info['first_block']:,} {src_label}")


if __name__ == "__main__":
    main()
