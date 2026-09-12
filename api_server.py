#!/usr/bin/env python3
"""
Robin Hood Wallet Analyzer API
Query any token on Robin Hood Chain mainnet to find early buyers
"""

import json
import subprocess
import re
import asyncio
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

app = FastAPI(title="Robin Hood Wallet Analyzer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

RPC_URL = "https://rpc.mainnet.chain.robinhood.com"


class ContractRequest(BaseModel):
    address: str
    block_range: int = 5000


class WalletInfo(BaseModel):
    address: str
    type: str
    badge: str
    amount: str
    first_buy_block: Optional[int]
    tx_hash: Optional[str]
    tx_count: int
    eth_balance: float


class TokenInfo(BaseModel):
    name: str
    symbol: str
    supply: int
    decimals: int
    deploy_block: int
    total_transfers: int


class ScanResponse(BaseModel):
    token: TokenInfo
    wallets: list[WalletInfo]
    stats: dict


async def run_rpc_async(method: str, params: list) -> dict:
    """Execute RPC call via curl asynchronously"""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": 1
    })
    
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "--location", RPC_URL,
            "--header", "Content-Type: application/json",
            "--data", payload,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
        
        try:
            return json.loads(stdout.decode())
        except:
            return {"error": "Failed to parse response"}
    except asyncio.TimeoutError:
        return {"error": "RPC timeout"}
    except Exception as e:
        return {"error": str(e)}


def hex_to_int(hex_str: str) -> int:
    """Convert hex string to int"""
    if not hex_str or hex_str == "0x" or hex_str == "0x0":
        return 0
    if hex_str and hex_str.startswith("0x"):
        try:
            return int(hex_str, 16)
        except (ValueError, TypeError):
            return 0
    try:
        return int(hex_str)
    except (ValueError, TypeError):
        return 0


def format_amount(value: int, decimals: int) -> str:
    """Format token amount with decimals"""
    if value == 0:
        return "0"
    formatted = value / (10 ** decimals)
    if formatted >= 1_000_000:
        return f"{formatted/1_000_000:.1f}M"
    elif formatted >= 1_000:
        return f"{formatted/1_000:.1f}K"
    return f"{formatted:.2f}"


async def get_current_block() -> int:
    """Get current block number"""
    resp = await run_rpc_async("eth_blockNumber", [])
    return hex_to_int(resp.get("result", "0x0"))


async def find_deploy_block(address: str, current_block: int) -> int:
    """Find approximate deploy block - scan backward in chunks"""
    search_start = max(0, current_block - 2000)
    
    resp = await run_rpc_async("eth_getLogs", [{
        "fromBlock": hex(search_start),
        "toBlock": hex(current_block),
        "address": address,
        "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
    }])
    
    logs = resp.get("result", [])
    if not logs:
        search_start = max(0, current_block - 10000)
        resp = await run_rpc_async("eth_getLogs", [{
            "fromBlock": hex(search_start),
            "toBlock": hex(current_block),
            "address": address,
            "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
        }])
        logs = resp.get("result", [])
    
    if not logs:
        return current_block - 1000
    
    min_block = current_block
    for log in logs:
        block = hex_to_int(log.get("blockNumber", "0x0"))
        if block < min_block:
            min_block = block
    
    return min_block


async def get_token_calls(address: str) -> dict:
    """Get all token metadata calls in parallel"""
    name_call = asyncio.create_task(run_rpc_async("eth_call", [{"to": address, "data": "0x06fdde03"}, "latest"]))
    decimals_call = asyncio.create_task(run_rpc_async("eth_call", [{"to": address, "data": "0x313ce567"}, "latest"]))
    symbol_call = asyncio.create_task(run_rpc_async("eth_call", [{"to": address, "data": "0x95d89b41"}, "latest"]))
    supply_call = asyncio.create_task(run_rpc_async("eth_call", [{"to": address, "data": "0x18160ddd"}, "latest"]))
    
    results = await asyncio.gather(name_call, decimals_call, symbol_call, supply_call)
    
    return {
        "name_resp": results[0],
        "decimals_resp": results[1],
        "symbol_resp": results[2],
        "supply_resp": results[3]
    }


def decode_string_result(hex_data: str) -> str:
    """Decode UTF-8 string from hex result"""
    if not hex_data or hex_data == "0x":
        return ""
    try:
        raw = hex_data[2:]
        # Decode as UTF-8
        decoded = bytes.fromhex(raw).decode('utf-8', errors='ignore')
        # Strip null bytes and whitespace
        cleaned = decoded.replace('\x00', '').replace('\x04', '').strip()
        return cleaned
    except:
        return ""


def decode_uint256(hex_data: str) -> int:
    """Decode uint256 from hex result (handles both full and compact forms)"""
    if not hex_data or hex_data == "0x" or hex_data == "0x0":
        return 0
    try:
        raw = hex_data[2:]
        # Handle compact form (right-padded with zeros)
        # Standard: last 32 bytes is the value
        if len(raw) <= 64:
            return int(raw, 16)
        else:
            # Take last 64 chars (32 bytes) for standard uint256
            return int(raw[-64:], 16)
    except:
        return 0


async def get_early_transfers_parallel(address: str, from_block: int, to_block: int, chunk_size: int = 5000) -> list:
    """Get transfer events in block range - parallel chunks"""
    tasks = []
    current = from_block
    
    while current <= to_block:
        end = min(current + chunk_size - 1, to_block)
        tasks.append(run_rpc_async("eth_getLogs", [{
            "fromBlock": hex(current),
            "toBlock": hex(end),
            "address": address,
            "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
        }]))
        current = end + 1
    
    all_logs = []
    for i in range(0, len(tasks), 5):
        batch = tasks[i:i+5]
        results = await asyncio.gather(*batch)
        for resp in results:
            logs = resp.get("result", [])
            if logs:
                all_logs.extend(logs)
    
    return all_logs


async def classify_wallets(transfers: list, token_address: str) -> list[WalletInfo]:
    """Classify wallets based on transfer patterns"""
    wallet_stats = {}
    
    for log in transfers:
        topics = log.get("topics", [])
        if len(topics) < 3:
            continue
        
        from_addr = "0x" + topics[1][26:]
        to_addr = "0x" + topics[2][26:]
        amount = hex_to_int(log.get("data", "0x0"))
        block = hex_to_int(log.get("blockNumber", "0x0"))
        tx_hash = log.get("transactionHash")
        
        if from_addr not in wallet_stats:
            wallet_stats[from_addr] = {
                "sent": 0,
                "received": 0,
                "blocks": [],
                "tx_hashes": set(),
            }
        wallet_stats[from_addr]["sent"] += amount
        wallet_stats[from_addr]["blocks"].append(block)
        if tx_hash:
            wallet_stats[from_addr]["tx_hashes"].add(tx_hash)
        
        if to_addr not in wallet_stats:
            wallet_stats[to_addr] = {
                "sent": 0,
                "received": 0,
                "blocks": [],
                "tx_hashes": set(),
            }
        wallet_stats[to_addr]["received"] += amount
        wallet_stats[to_addr]["blocks"].append(block)
        if tx_hash:
            wallet_stats[to_addr]["tx_hashes"].add(tx_hash)
    
    addr_list = list(wallet_stats.keys())[:100]
    
    code_tasks = {}
    balance_tasks = {}
    txcount_tasks = {}
    
    for addr in addr_list:
        code_tasks[addr] = asyncio.create_task(run_rpc_async("eth_getCode", [addr, "latest"]))
        balance_tasks[addr] = asyncio.create_task(run_rpc_async("eth_getBalance", [addr, "latest"]))
        txcount_tasks[addr] = asyncio.create_task(run_rpc_async("eth_getTransactionCount", [addr, "latest"]))
    
    all_results = await asyncio.gather(
        *(list(code_tasks.values()) + list(balance_tasks.values()) + list(txcount_tasks.values()))
    )
    
    idx = 0
    for addr in addr_list:
        wallet_stats[addr]["is_contract"] = all_results[idx].get("result", "0x") != "0x"
        idx += 1
        eth_bal_raw = hex_to_int(all_results[idx].get("result", "0x0"))
        eth_bal = round(eth_bal_raw / 1e18, 4) if eth_bal_raw < 1e30 else 999999.0  # Cap at 1M ETH
        wallet_stats[addr]["eth_balance"] = eth_bal
        idx += 1
        wallet_stats[addr]["tx_count"] = hex_to_int(all_results[idx].get("result", "0x0"))
        idx += 1
    
    wallets = []
    for addr, stats in wallet_stats.items():
        if addr.lower() == token_address.lower():
            continue
        
        if stats["received"] > 0:
            if stats.get("is_contract") and stats["received"] > 1e12:
                wtype = "pool_manager"
                badge = "Pool Manager"
            elif stats.get("is_contract"):
                wtype = "contract"
                badge = "Contract"
            elif len(stats["tx_hashes"]) > 100 and stats["sent"] / max(stats["received"], 1) > 0.9:
                wtype = "burner"
                badge = "Burner"
            else:
                wtype = "buyer"
                badge = "Early Buyer"
            amount = stats["received"]
        elif stats["sent"] > 0:
            wtype = "contract"
            badge = "Distributor"
            amount = 0
        else:
            wtype = "buyer"
            badge = "Active Wallet"
            amount = 0
        
        first_block = min(stats["blocks"]) if stats["blocks"] else None
        
        wallets.append(WalletInfo(
            address=addr,
            type=wtype,
            badge=badge,
            amount=format_amount(amount, 18),
            first_buy_block=first_block,
            tx_hash=list(stats["tx_hashes"])[0] if stats["tx_hashes"] else None,
            tx_count=len(stats["tx_hashes"]),
            eth_balance=float(stats.get("eth_balance", 0))
        ))
    
    wallets.sort(key=lambda x: x.first_buy_block or 0)
    
    return wallets


@app.get("/")
async def root():
    return {"message": "Robin Hood Wallet Analyzer API", "status": "online"}


@app.post("/scan", response_model=ScanResponse)
async def scan(request: ContractRequest):
    """Scan a token contract for early buyers"""
    if not re.match(r'^0x[a-fA-F0-9]{40}$', request.address):
        raise HTTPException(status_code=400, detail="Invalid contract address")
    
    address = request.address.lower()
    
    try:
        current_block = await get_current_block()
        deploy_block = await find_deploy_block(address, current_block)
        calls = await get_token_calls(address)
        
        name_hex = calls["name_resp"].get("result", "")
        decimals_hex = calls["decimals_resp"].get("result", "")
        symbol_hex = calls["symbol_resp"].get("result", "")
        supply_hex = calls["supply_resp"].get("result", "")
        
        name = decode_string_result(name_hex) or "Unknown Token"
        symbol = decode_string_result(symbol_hex) or "TKN"
        decimals = hex_to_int(decimals_hex) if decimals_hex else 18
        supply = decode_uint256(supply_hex)
        
        scan_start = max(deploy_block, deploy_block - 100)
        scan_end = min(deploy_block + request.block_range, current_block)
        
        transfers = await get_early_transfers_parallel(address, scan_start, scan_end)
        wallets = await classify_wallets(transfers, address)
        
        buyers = [w for w in wallets if w.type == "buyer"]
        contracts = [w for w in wallets if w.type in ("contract", "pool_manager")]
        burners = [w for w in wallets if w.type == "burner"]
        
        return ScanResponse(
            token=TokenInfo(
                name=name,
                symbol=symbol,
                supply=supply,
                decimals=decimals,
                deploy_block=deploy_block,
                total_transfers=len(transfers)
            ),
            wallets=wallets[:50],
            stats={
                "total_wallets": len(wallets),
                "real_buyers": len(buyers),
                "contracts_filtered": len(contracts),
                "burners_filtered": len(burners),
                "scan_range_blocks": scan_end - scan_start
            }
        )
    except Exception as e:
        import traceback
        print(f"ERROR in scan: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"{str(e)}")


@app.get("/wallet/{address}")
async def get_wallet(address: str):
    """Get wallet analysis"""
    if not re.match(r'^0x[a-fA-F0-9]{40}$', address):
        raise HTTPException(status_code=400, detail="Invalid address")
    
    tx_count_task = asyncio.create_task(run_rpc_async("eth_getTransactionCount", [address, "latest"]))
    eth_balance_task = asyncio.create_task(run_rpc_async("eth_getBalance", [address, "latest"]))
    code_task = asyncio.create_task(run_rpc_async("eth_getCode", [address, "latest"]))
    
    results = await asyncio.gather(tx_count_task, eth_balance_task, code_task)
    
    tx_count = hex_to_int(results[0].get("result", "0x0"))
    eth_balance = hex_to_int(results[1].get("result", "0x0")) / 1e18
    is_contract = results[2].get("result", "0x") != "0x"
    
    return {
        "address": address,
        "tx_count": tx_count,
        "eth_balance": round(eth_balance, 4),
        "is_contract": is_contract
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
