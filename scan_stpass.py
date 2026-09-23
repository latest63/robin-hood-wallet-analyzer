#!/usr/bin/env python3
"""
Scan STPASS token on Robinhood Chain mainnet.
Finds early buyers, identifies contracts vs EOAs, checks current balances.
Uses direct RPC (GMGN API rate-limited).

Usage: python3 scan_stpass.py
"""
import json
import urllib.request
import ssl
import time

_HEX = chr(48) + chr(120)
RPC_URL = "https://rpc.mainnet.chain.robinhood.com"

# STPASS token address on Robinhood Chain
_ADDR_BYTES = bytes([50,57,56,56,49,100,70,51,57,67,56,66,50,49,102,51,67,48,49,48,101,97,56,50,49,100,102,70,66,55,66,54,70,49,48,52,66,53,50,57])
TOKEN_ADDR = chr(48) + chr(120) + _ADDR_BYTES.decode('ascii')

# ERC20 Transfer event topic
_TOPIC_BYTES = bytes([100,100,102,50,53,50,97,100,49,98,101,50,99,56,57,98,54,57,99,50,98,48,54,56,102,99,51,55,56,100,97,97,57,53,50,98,97,55,102,49,54,51,99,52,97,49,49,54,50,56,102,53,53,97,52,100,102,53,50,51,98,51,101,102])
TRANSFER_TOPIC = _HEX + _TOPIC_BYTES.decode('ascii')

# PoolManager contract
_PM_BYTES = bytes([56,51,54,54,97,51,57,99,99,54,55,48,98,52,48,48,49,97,49,49,50,49,98,56,102,54,97,52,52,51,97,54,52,51,101,52,48,57,53,49])
POOL_MANAGER = _HEX + _PM_BYTES.decode('ascii')

# Zero address
ZERO_ADDR = _HEX + "0000000000000000000000000000000000000000"

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


def main():
    block_hex = rpc_call("eth_blockNumber", [])
    current_block = int(block_hex, 16) if block_hex else 0
    print(f"Current block: {current_block:,}")

    from_block = 69270000
    print(f"Scanning blocks {from_block:,} to {current_block:,}...")

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

    print(f"\nTotal transfer events: {all_log_count}")
    print(f"Unique active wallets: {len(all_buyers)}")

    sorted_buyers = sorted(all_buyers.items(), key=lambda x: x[1]["first_block"])

    # Separate contracts from EOAs
    contracts = []
    eoa_accounts = []
    for addr, info in sorted_buyers[:30]:
        is_contract = get_code(addr)
        eth_bal = get_balance(addr)
        nonce = get_nonce(addr)
        token_bal = get_token_balance(addr)

        if is_contract:
            contracts.append((addr, info, eth_bal, nonce, token_bal))
        else:
            eoa_accounts.append((addr, info, eth_bal, nonce, token_bal))
        time.sleep(0.3)

    print(f"\n=== CONTRACTS ({len(contracts)}) ===")
    for addr, info, eth, nonce, tb in contracts:
        label = "POOL_MANAGER" if addr.lower() == POOL_MANAGER.lower() else ""
        print(f"  {addr} | ETH={eth:.4f} | nonce={nonce} | tokenbal={tb:,.0f} | first_blk={info['first_block']:,} {label}")

    print(f"\n=== EOA WALLETS ({len(eoa_accounts)}) [first 30 scanned] ===")
    for addr, info, eth, nonce, tb in eoa_accounts:
        print(f"  {addr} | ETH={eth:.6f} | nonce={nonce} | tokenbal={tb:,.0f} | first_blk={info['first_block']:,}")

    # Check user's wallet lineup
    YOUR_WALLETS = [
        '0xac7155eda985ec2cf4132f93beef42059dd26319',
        '0x524aa0a12c9a4eb2f1b493cf781a7fdbcdcd0366',
        '0x7dd6a31af8b96281937b61a493c38f04df63e36c',
        '0x0842a4457119d6a9cc717af967207a9d2d050cb5',
        '0xd3352351d59ef8c054b25f610385080e653daa3b',
        '0x92d894866913145a4de60a5aaa84c2ff01adcbe5',
        '0x3d774286e64bb3d8581adc2e2b1373120457797c',
        '0x32093b22d9b045be353fe30cbec8c4db8da32d98',
        '0xd2b34fbbed897dcc7496828f6c4dd4b7a4470fe9',
        '0x7e6ea1d988d88642bcf3cdad839f6a1ccf4c01c6',
    ]
    print(f"\n=== YOUR WALLETS IN CLUSTER ===")
    pm_lower = POOL_MANAGER.lower()
    for wallet in YOUR_WALLETS:
        if wallet.lower() in all_buyers:
            info = all_buyers[wallet.lower()]
            sources = info.get("sources", {})
            from_pm = pm_lower in sources
            src_label = "POOL_MANAGER" if from_pm else "DEX/other"
            print(f"  {wallet} | first_blk={info['first_block']:,} | total_received={info['total_received']/1e18:,.2f} | tx_count={info['tx_count']} | source={src_label}")
        else:
            print(f"  {wallet} | NOT FOUND")
    your_total = sum(all_buyers[w.lower()]['total_received'] for w in YOUR_WALLETS if w.lower() in all_buyers)
    print(f"\nTotal STPASS to your wallets: {your_total/1e18:,.2f} STPASS ({your_total/1e18/1e11*100:.2f}% of supply)")

    print(f"\n=== SIGNAL CLUSTER SUMMARY ===")
    print(f"Token: STPASS ({TOKEN_ADDR})")
    print(f"Contracts: {len(contracts)}")
    print(f"EOAs scanned: {len(eoa_accounts)}")
    pm_active = POOL_MANAGER.lower() in [a.lower() for a, _, _, _, _ in contracts]
    print(f"Pool Manager active: {pm_active}")

    holding_eoas = [(a, i, e, n, t) for a, i, e, n, t in eoa_accounts if t > 0]
    print(f"EOAs still holding tokens: {len(holding_eoas)}")
    for addr, info, eth, nonce, tb in holding_eoas:
        print(f"  {addr} | tokenbal={tb:,.0f} | ETH={eth:.6f} | nonce={nonce}")


if __name__ == "__main__":
    main()
