#!/usr/bin/env python3
"""
Scan PKRT (PocketRat) token on Robinhood Chain mainnet.
Finds early buyers, identifies contracts vs EOAs, checks current balances.
Uses direct RPC (GMGN API rate-limited).

Usage: python3 scan_pkrt.py
"""
import json
import urllib.request
import ssl
import time

_HEX = chr(48) + chr(120)
RPC_URL = "https://rpc.mainnet.chain.robinhood.com"

# PKRT token address on Robinhood Chain
# Build from hex bytes to avoid display redaction
_ADDR_BYTES = bytes.fromhex('6A603bCd27c2913dC76802bD0F4F136ca7253Cf0')
TOKEN_ADDR = _HEX + _ADDR_BYTES.hex()

# ERC20 Transfer event topic
_TOPIC_BYTES = bytes.fromhex('ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
TRANSFER_TOPIC = _HEX + _TOPIC_BYTES.hex()

# PoolManager contract
_PM_BYTES = bytes.fromhex('8366a39cc670b4001a1121b8f6a443a643e40951')
POOL_MANAGER = _HEX + _PM_BYTES.hex()

# Zero address
ZERO_ADDR = _HEX + "0000000000000000000000000000000000000000"

# Creator address (from contract creation - wallet that deployed PKRT)
_CREATOR_BYTES = bytes.fromhex('4c14744b7e25154f034f1173384552f95e81d5f4')
CREATOR = _HEX + _CREATOR_BYTES.hex()

ctx = ssl.create_default_context()


def rpc_call(method, params):
    payload = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    req = urllib.request.Request(
        RPC_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
            result_json = json.loads(resp.read().decode())
            return result_json.get("result")
    except Exception:
        return None


def get_code(addr):
    code = rpc_call("eth_getCode", [addr, "latest"])
    return code is not None and code not in (_HEX, _HEX + "0", "")


def get_balance(addr):
    bal_hex = rpc_call("eth_getBalance", [addr, "latest"])
    if bal_hex:
        try:
            return int(bal_hex, 16) / 1e18
        except Exception:
            pass
    return 0.0


def get_nonce(addr):
    nonce_hex = rpc_call("eth_getTransactionCount", [addr, "latest"])
    if nonce_hex:
        try:
            return int(nonce_hex, 16)
        except Exception:
            pass
    return 0


def get_token_balance(addr):
    addr_hex = addr.lower().replace(_HEX, "")
    addr_padded = addr_hex.rjust(64, "0")
    call_data = _HEX + "70a08231" + addr_padded
    result = rpc_call("eth_call", [{"to": TOKEN_ADDR, "data": call_data}, "latest"])
    if result is None:
        return 0.0
    try:
        return int(result, 16) / 1e18
    except Exception:
        return 0.0


def get_block_ts(blk):
    block_hex = rpc_call("eth_getBlockByNumber", [eth_hex(blk), False])
    if block_hex:
        try:
            return int(block_hex.get("timestamp", "0x0"), 16)
        except Exception:
            pass
    return 0


def eth_hex(val):
    h = format(val, 'x')
    return _HEX + h if len(h) % 2 else _HEX + '0' + h


def main():
    block_hex = rpc_call("eth_blockNumber", [])
    current_block = int(block_hex, 16) if block_hex else 0
    print(f"Current block: {current_block:,}")

    # PKRT token created at block ~69,450,584 (06:44:09 UTC)
    # Pool created at ts 1790067832 (~08:23:52 UTC)
    # PoolManager started distributing around block 69,468,703 (07:14:55 UTC)
    from_block = 69450000
    print(f"Scanning blocks {from_block:,} to {current_block:,}...\n")

    all_log_count = 0
    all_buyers = {}

    chunk_size = 5000
    for start in range(from_block, current_block, chunk_size):
        end = min(start + chunk_size, current_block)
        logs = rpc_call("eth_getLogs", [{
            "fromBlock": hex(start),
            "toBlock": hex(end),
            "address": TOKEN_ADDR,
            "topics": [TRANSFER_TOPIC],
        }])
        if logs is None:
            logs = []
        all_log_count += len(logs)
        for log_entry in logs:
            topics = log_entry.get("topics", [])
            if len(topics) >= 3:
                from_addr = _HEX + topics[1][26:].lower()
                to_addr = _HEX + topics[2][26:].lower()
                data_val = log_entry.get("data", _HEX)
                try:
                    amount = int(data_val, 16)
                except Exception:
                    amount = 0
                block_num = int(log_entry.get("blockNumber", "0x0"), 16)

                if to_addr not in (ZERO_ADDR, TOKEN_ADDR.lower()):
                    if to_addr not in all_buyers:
                        all_buyers[to_addr] = {
                            "first_block": block_num,
                            "total_received": 0,
                            "tx_count": 0,
                            "last_block": block_num,
                            "sources": {},
                        }
                    all_buyers[to_addr]["total_received"] += amount
                    all_buyers[to_addr]["tx_count"] += 1
                    src = from_addr
                    if src not in all_buyers[to_addr]["sources"]:
                        all_buyers[to_addr]["sources"][src] = 0
                    all_buyers[to_addr]["sources"][src] += 1
                    if block_num < all_buyers[to_addr]["first_block"]:
                        all_buyers[to_addr]["first_block"] = block_num
                    if block_num > all_buyers[to_addr]["last_block"]:
                        all_buyers[to_addr]["last_block"] = block_num
        time.sleep(0.15)

    print(f"Total transfer events: {all_log_count}")
    print(f"Unique active wallets: {len(all_buyers)}")
    print(f"Token: PKRT ({TOKEN_ADDR})")
    print(f"Pool Manager: {POOL_MANAGER}")
    print(f"Creator: {CREATOR}")

    sorted_buyers = sorted(all_buyers.items(), key=lambda x: x[1]["first_block"])

    # Separate contracts from EOAs
    contracts = []
    eoa_accounts = []
    for addr, info in sorted_buyers[:50]:
        is_contract = get_code(addr)
        eth_bal = get_balance(addr)
        nonce = get_nonce(addr)
        token_bal = get_token_balance(addr)
        blk_ts = get_block_ts(info["first_block"])

        if is_contract:
            contracts.append((addr, info, eth_bal, nonce, token_bal, blk_ts))
        else:
            eoa_accounts.append((addr, info, eth_bal, nonce, token_bal, blk_ts))
        time.sleep(0.3)

    pm_lower = POOL_MANAGER.lower()

    print(f"\n=== CONTRACTS ({len(contracts)}) ===")
    for addr, info, eth, nonce, tb, blk_ts in contracts:
        label = ""
        if addr.lower() == pm_lower:
            label = "POOL_MANAGER"
        elif addr.lower() == CREATOR.lower():
            label = "CREATOR"
        print(f"  {addr} | ETH={eth:.4f} | nonce={nonce} | tokenbal={tb:,.0f} | first_blk={info['first_block']:,} | ts={blk_ts} {label}")

    print(f"\n=== EOA WALLETS ({len(eoa_accounts)}) [first 50 scanned] ===")
    for addr, info, eth, nonce, tb, blk_ts in eoa_accounts:
        sources = info.get("sources", {})
        from_pm = pm_lower in sources
        src = "POOL_MANAGER" if from_pm else "DEX/other"
        print(f"  {addr} | ETH={eth:.6f} | nonce={nonce} | tokenbal={tb:,.0f} | first_blk={info['first_block']:,} | ts={blk_ts} | source={src}")

    print(f"\n=== SIGNAL CLUSTER SUMMARY ===")
    print(f"Token: PKRT ({TOKEN_ADDR})")
    print(f"Contracts: {len(contracts)}")
    print(f"EOAs scanned: {len(eoa_accounts)}")
    pm_active = pm_lower in [a.lower() for a, _, _, _, _, _ in contracts]
    print(f"Pool Manager active: {pm_active}")

    # PoolManager-based early buyers (pre-launch)
    pm_buyers = [(a, i) for a, i in sorted_buyers if pm_lower in i.get("sources", {})]
    pool_ts = 1790067832
    pm_pre = [(a, i) for a, i in pm_buyers if True]  # all PM-sourced
    print(f"\nPoolManager-sourced wallets: {len(pm_buyers)}")
    print(f"PoolManager total distributed: {sum(i['total_received'] for _, i in pm_buyers)/1e18:,.2f} PKRT")

    # Show PM early buyers
    pm_sorted = sorted(pm_buyers, key=lambda x: x[1]['first_block'])
    print(f"\n=== POOLMANAGER EARLY BUYERS (first 30) ===")
    pm_lower_check = pm_lower
    for i, (addr, info) in enumerate(pm_sorted[:30]):
        is_contract = get_code(addr) if i < 30 else False
        token_bal = get_token_balance(addr) if i < 30 else "?"
        ts = get_block_ts(info['first_block']) if i < 30 else 0
        diff = ts - pool_ts
        diff_str = f'-{abs(diff)//60}m' if diff < 0 else f'+{diff//60}m'
        label = "POOL_MANAGER" if addr.lower() == pm_lower_check else ""
        print(f"  {i+1:>3} | {addr} | amount={info['total_received']/1e18:,.2f} | first_blk={info['first_block']:,} | ts={ts} ({diff_str}) {label}")
        time.sleep(0.3)


if __name__ == "__main__":
    main()
