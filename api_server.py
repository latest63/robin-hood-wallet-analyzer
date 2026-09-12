#!/usr/bin/env python3
"""
Robin Hood Wallet Analyzer API
Query any token on Robin Hood Chain mainnet to find early buyers
"""

import json
import subprocess
import re
from datetime import datetime
from typing import Optional
import asyncio
import aiohttp
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
BLOCK_TIME = 0.117  # seconds per block
TOKEN_CONTRACT_ADDRESS = None


class ContractRequest(BaseModel):
    address: str
    block_range: int = 5000  # default scan range


class WalletInfo(BaseModel):
    address: str
    type: str  # buyer, contract, pool_manager, burner
    badge: str
    amount: float
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


def run_rpc(method: str, params: list) -> dict:
    """Execute RPC call via curl"""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": 1
    })
    
    result = subprocess.run(
        ["curl", "-s", "--location", RPC_URL, 
         "--header", "Content-Type: application/json",
         "--data", payload],
        capture_output=True, text=True, timeout=15
    )
    
    try:
        return json.loads(result.stdout)
    except:
        return {"error": "Failed to parse response"}


def hex_to_int(hex_str: str) -> int:
    """Convert hex string to int"""
    if hex_str and hex_str.startswith("0x"):
        return int(hex_str, 16)
    return int(hex_str) if hex_str else 0


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


async def scan_token(address: str, block_range: int = 5000) -> ScanResponse:
    """Scan token contract for early buyers"""
    
    # Validate address
    if not re.match(r'^0x[a-fA-F0-9]{40}$', address):
        raise HTTPException(status_code=400, detail="Invalid contract address")
    
    address = address.lower()
    
    # Get current block
    block_resp = run_rpc("eth_blockNumber", [])
    current_block = hex_to_int(block_resp.get("result", "0x0"))
    
    # Get deploy block (approximate - scan backwards)
    deploy_block = await find_deploy_block(address, current_block)
    
    # Get token info
    token_info = await get_token_info(address, deploy_block)
    
    # Scan for transfers in early blocks
    scan_start = max(deploy_block + 1, deploy_block - 1000)
    scan_end = min(deploy_block + block_range, current_block)
    
    transfers = await get_early_transfers(address, scan_start, scan_end)
    
    # Classify wallets
    wallets = classify_wallets(transfers, address)
    
    # Calculate stats
    buyers = [w for w in wallets if w.type == "buyer"]
    contracts = [w for w in wallets if w.type in ("contract", "pool_manager")]
    burners = [w for w in wallets if w.type == "burner"]
    
    return ScanResponse(
        token=token_info,
        wallets=wallets,
        stats={
            "total_wallets": len(wallets),
            "real_buyers": len(buyers),
            "contracts_filtered": len(contracts),
            "burners_filtered": len(burners),
            "scan_range_blocks": scan_end - scan_start
        }
    )


async def find_deploy_block(address: str, current_block: int) -> int:
    """Find approximate deploy block by binary search"""
    low, high = max(0, current_block - 100000), current_block
    
    # Quick check - look at last 1000 blocks
    chunk_size = 1000
    while low < high:
        mid = (low + high) // 2
        resp = run_rpc("eth_getLogs", [{
            "fromBlock": hex(mid),
            "toBlock": hex(min(mid + chunk_size, current_block)),
            "address": address,
            "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
        }])
        
        if resp.get("result"):
            high = mid
        else:
            low = mid + chunk_size
    
    return low


async def get_token_info(address: str, deploy_block: int) -> TokenInfo:
    """Get token metadata"""
    # Try to get name
    name_resp = run_rpc("eth_call", [{"to": address, "data": "0x06fdde03"}, "latest"])
    name = "Unknown Token"
    
    # Try decimals
    dec_resp = run_rpc("eth_call", [{"to": address, "data": "0x313ce567"}, "latest"])
    decimals = 18
    
    # Try supply (total)
    supply_resp = run_rpc("eth_call", [{"to": address, "data": "0x18160ddd"}, "latest"])
    supply = 0
    
    return TokenInfo(
        name=name,
        symbol="TKN",
        supply=supply,
        decimals=decimals,
        deploy_block=deploy_block,
        total_transfers=len(run_rpc("eth_getLogs", [{
            "fromBlock": hex(deploy_block),
            "toBlock": "latest",
            "address": address,
            "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
        }]).get("result", []))
    )


async def get_early_transfers(address: str, from_block: int, to_block: int) -> list:
    """Get transfer events in block range"""
    # Split into chunks to avoid timeout
    chunk_size = 2000
    all_logs = []
    
    current = from_block
    while current <= to_block:
        end = min(current + chunk_size, to_block)
        
        resp = run_rpc("eth_getLogs", [{
            "fromBlock": hex(current),
            "toBlock": hex(end),
            "address": address,
            "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
        }])
        
        logs = resp.get("result", [])
        if logs:
            all_logs.extend(logs)
        
        current = end + 1
        
        # Rate limiting
        await asyncio.sleep(0.1)
    
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
        
        # Track sender
        if from_addr not in wallet_stats:
            wallet_stats[from_addr] = {
                "sent": 0,
                "received": 0,
                "blocks": [],
                "tx_hashes": set(),
                "is_contract": False
            }
        wallet_stats[from_addr]["sent"] += amount
        wallet_stats[from_addr]["blocks"].append(block)
        if tx_hash:
            wallet_stats[from_addr]["tx_hashes"].add(tx_hash)
        
        # Track receiver
        if to_addr not in wallet_stats:
            wallet_stats[to_addr] = {
                "sent": 0,
                "received": 0,
                "blocks": [],
                "tx_hashes": set(),
                "is_contract": False
            }
        wallet_stats[to_addr]["received"] += amount
        wallet_stats[to_addr]["blocks"].append(block)
        if tx_hash:
            wallet_stats[to_addr]["tx_hashes"].add(tx_hash)
    
    # Check which are contracts
    for addr in wallet_stats:
        code_resp = run_rpc("eth_getCode", [addr, "latest"])
        code = code_resp.get("result", "0x")
        wallet_stats[addr]["is_contract"] = code != "0x"
    
    # Build wallet list
    wallets = []
    for addr, stats in wallet_stats.items():
        # Skip the token contract itself
        if addr.lower() == token_address.lower():
            continue
        
        # Classify
        if stats["received"] == 0 and stats["sent"] > 0:
            # Only sent tokens, never received - likely distributor
            wtype = "contract"
            badge = "Distributor"
            amount = 0
        elif stats["received"] > 0:
            if stats["is_contract"] and stats["received"] > 1e12:
                wtype = "pool_manager"
                badge = "Pool Manager"
            elif stats["is_contract"]:
                wtype = "contract"
                badge = "Contract"
            elif len(stats["tx_hashes"]) > 100 and stats["sent"] / max(stats["received"], 1) > 0.9:
                wtype = "burner"
                badge = "Burner"
            else:
                wtype = "buyer"
                badge = "Early Buyer"
            amount = stats["received"]
        else:
            wtype = "buyer"
            badge = "Active Wallet"
            amount = 0
        
        # Get first buy block
        first_block = min(stats["blocks"]) if stats["blocks"] else None
        
        # Get ETH balance
        eth_resp = run_rpc("eth_getBalance", [addr, "latest"])
        eth_balance = hex_to_int(eth_resp.get("result", "0x0")) / 1e18
        
        wallets.append(WalletInfo(
            address=addr,
            type=wtype,
            badge=badge,
            amount=format_amount(amount, 18),
            first_buy_block=first_block,
            tx_hash=list(stats["tx_hashes"])[0] if stats["tx_hashes"] else None,
            tx_count=len(stats["tx_hashes"]),
            eth_balance=round(eth_balance, 4)
        ))
    
    # Sort by first buy block (earliest first)
    wallets.sort(key=lambda x: x.first_buy_block or 0)
    
    return wallets


@app.get("/")
async def root():
    return {"message": "Robin Hood Wallet Analyzer API", "status": "online"}


@app.post("/scan", response_model=ScanResponse)
async def scan(request: ContractRequest):
    """Scan a token contract for early buyers"""
    return await scan_token(request.address, request.block_range)


@app.get("/wallet/{address}")
async def get_wallet(address: str):
    """Get wallet analysis"""
    if not re.match(r'^0x[a-fA-F0-9]{40}$', address):
        raise HTTPException(status_code=400, detail="Invalid address")
    
    # Get transaction count
    tx_resp = run_rpc("eth_getTransactionCount", [address, "latest"])
    tx_count = hex_to_int(tx_resp.get("result", "0x0"))
    
    # Get ETH balance
    eth_resp = run_rpc("eth_getBalance", [address, "latest"])
    eth_balance = hex_to_int(eth_resp.get("result", "0x0")) / 1e18
    
    # Check if contract
    code_resp = run_rpc("eth_getCode", [address, "latest"])
    is_contract = code_resp.get("result", "0x") != "0x"
    
    return {
        "address": address,
        "tx_count": tx_count,
        "eth_balance": round(eth_balance, 4),
        "is_contract": is_contract,
        "last_active": "unknown"
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
