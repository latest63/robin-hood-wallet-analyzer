#!/usr/bin/env python3
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import subprocess
import json
import os
import threading
import time
import requests
from datetime import datetime

app = FastAPI()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state
monitoring_active = False
monitor_thread = None
cluster_data = []
current_webhook = ""

DATA_FILE = "data/cluster.json"
CHAIN = "robinhood"

def run_gmgn(args):
    """Run gmgn-cli command"""
    try:
        result = subprocess.run(["gmgn-cli"] + args, capture_output=True, text=True, timeout=60)
        if result.returncode == 0 and result.stdout:
            return json.loads(result.stdout)
    except Exception as e:
        print(f"GMGN Error: {e}")
    return None

@app.get("/", response_class=HTMLResponse)
async def root():
    # Serve the new frontend
    if os.path.exists("gmgn_dashboard.html"):
        with open("gmgn_dashboard.html", "r") as f:
            return f.read()
    return "Frontend not found"

@app.post("/api/scan")
async def scan_token(request: Request):
    data = await request.json()
    token = data.get("token")
    if not token:
        raise HTTPException(status_code=400, detail="Token address required")
    
    # Get token info
    token_info = run_gmgn(["token", "info", "--chain", CHAIN, "--address", token, "--raw"])
    if not token_info:
        raise HTTPException(status_code=404, detail="Token not found")
    
    # Get traders
    traders = run_gmgn([
        "token", "traders",
        "--chain", CHAIN,
        "--address", token,
        "--order-by", "profit",
        "--direction", "desc",
        "--limit", "50",
        "--raw"
    ])
    
    trader_list = []
    if traders and traders.get("list"):
        for t in traders["list"]:
            if "sandwich_bot" in t.get("tags", []):
                continue
            trader_list.append({
                "wallet": t.get("address"),
                "profit": t.get("profit", 0),
                "pnl": t.get("realized_pnl", 0),
                "buys": t.get("buy_tx_count_cur", 0),
                "selected": t.get("profit", 0) > 1000
            })
            
    return {
        "token": token_info,
        "traders": trader_list
    }

@app.post("/api/cluster/save")
async def save_cluster(request: Request):
    global cluster_data
    data = await request.json()
    cluster_data = data.get("cluster", [])
    os.makedirs("data", exist_ok=True)
    with open(DATA_FILE, "w") as f:
        json.dump(cluster_data, f, indent=2)
    return {"status": "ok", "count": len(cluster_data)}

@app.post("/api/monitor/start")
async def start_monitor(request: Request):
    global monitoring_active, monitor_thread, current_webhook
    
    data = await request.json()
    webhook = data.get("webhook")
    
    if not webhook:
        raise HTTPException(status_code=400, detail="Webhook URL required")
    if not cluster_data:
        raise HTTPException(status_code=400, detail="No cluster loaded")
        
    current_webhook = webhook
    monitoring_active = True
    
    def monitor_loop():
        global monitoring_active
        last_check = {}
        wallets = [w['wallet'] for w in cluster_data]
        
        print(f"Starting monitor for {len(wallets)} wallets")
        
        while monitoring_active:
            for w in cluster_data:
                if not monitoring_active:
                    break
                    
                wallet = w['wallet']
                try:
                    # Check recent activity
                    activity = run_gmgn([
                        "portfolio", "activity",
                        "--chain", CHAIN,
                        "--wallet", wallet,
                        "--limit", "3",
                        "--raw"
                    ])
                    
                    if activity and activity.get("list"):
                        for act in activity["list"]:
                            ts = act.get("timestamp", "")
                            if wallet not in last_check or last_check[wallet] < ts:
                                last_check[wallet] = ts
                                if act.get("type") == "buy":
                                    token_sym = act.get("token_symbol", "Unknown")
                                    profit = w.get("profit", 0)
                                    pnl = w.get("pnl", 0)
                                    
                                    msg = f"**Buy Alert:** {wallet[:10]}... bought {token_sym}\nProfit: ${profit:,.0f} ({pnl*100:.1f}%)"
                                    
                                    try:
                                        requests.post(current_webhook, json={"content": msg}, timeout=10)
                                    except:
                                        pass
                                        
                    time.sleep(1) # Rate limit
                except Exception as e:
                    print(f"Monitor error: {e}")
                    time.sleep(5)
            
            time.sleep(30) # Wait between cycles

    monitor_thread = threading.Thread(target=monitor_loop)
    monitor_thread.start()
    
    return {"status": "started"}

@app.post("/api/monitor/stop")
async def stop_monitor():
    global monitoring_active
    monitoring_active = False
    return {"status": "stopped"}

if __name__ == "__main__":
    import uvicorn
    # Load cluster if exists
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r") as f:
            cluster_data = json.load(f)
    uvicorn.run(app, host="0.0.0.0", port=8000)
