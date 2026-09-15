#!/usr/bin/env python3
"""
GMGN Cluster Monitor API
Wallet-based auth, SQLite database, GMGN integration
"""
from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import subprocess
import json
import os
import sqlite3
import hashlib
import secrets
import time
import jwt
import requests
from datetime import datetime, timedelta
from contextlib import contextmanager

# ── Config ──────────────────────────────────────────────────────────────────
JWT_SECRET = os.getenv("JWT_SECRET", secrets.token_hex(32))
JWT_EXPIRY_HOURS = 72
CHAIN = "robinhood"
DB_PATH = os.getenv("DB_PATH", "data/cluster.db")
GMGN_API_KEY = os.getenv("GMGN_API_KEY", "gmgn_d6464c033675a99e51bf16c4e2634c97")

# ── App ─────────────────────────────────────────────────────────────────────
app = FastAPI(title="GMGN Cluster Monitor")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://robin-hood-wallet-analyzer.vercel.app",
        "http://localhost:3000",
        "http://localhost:8000",
        "*"  # Remove in production
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Database ────────────────────────────────────────────────────────────────
def get_db():
    """Get database connection with WAL mode"""
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initialize database schema"""
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            wallet_address TEXT PRIMARY KEY,
            nonce TEXT NOT NULL,
            nonce_expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            last_login_at INTEGER
        );
        
        CREATE TABLE IF NOT EXISTS clusters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_wallet TEXT NOT NULL,
            name TEXT NOT NULL,
            token_address TEXT,
            token_symbol TEXT,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (user_wallet) REFERENCES users(wallet_address)
        );
        
        CREATE TABLE IF NOT EXISTS cluster_wallets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cluster_id INTEGER NOT NULL,
            wallet_address TEXT NOT NULL,
            profit REAL DEFAULT 0,
            pnl_pct REAL DEFAULT 0,
            added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
            UNIQUE(cluster_id, wallet_address)
        );
        
        CREATE TABLE IF NOT EXISTS monitors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cluster_id INTEGER NOT NULL,
            user_wallet TEXT NOT NULL,
            webhook_url TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            last_alert_at INTEGER,
            FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
            FOREIGN KEY (user_wallet) REFERENCES users(wallet_address)
        );
        
        CREATE INDEX IF NOT EXISTS idx_clusters_user ON clusters(user_wallet);
        CREATE INDEX IF NOT EXISTS idx_cluster_wallets_cluster ON cluster_wallets(cluster_id);
        CREATE INDEX IF NOT EXISTS idx_monitors_cluster ON monitors(cluster_id);
        CREATE INDEX IF NOT EXISTS idx_monitors_user ON monitors(user_wallet);
    """)
    conn.close()

init_db()

# ── Auth Helpers ────────────────────────────────────────────────────────────
def create_jwt(wallet: str) -> str:
    payload = {
        "wallet": wallet.lower(),
        "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.utcnow()
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def verify_jwt(token: str) -> str:
    """Returns wallet address from JWT"""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return payload["wallet"].lower()
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

def get_current_user(request: Request) -> str:
    """Extract wallet from Authorization header"""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing auth token")
    return verify_jwt(auth[7:])

# ── Signature Verification ──────────────────────────────────────────────────
def recover_signer(message: str, signature: str) -> str:
    """Recover Ethereum address from EIP-191 personal_sign"""
    try:
        from eth_account.messages import encode_defunct
        from eth_account import Account
        msg = encode_defunct(text=message)
        recovered = Account.recover_message(msg, signature=signature)
        return recovered.lower()
    except Exception as e:
        # Fallback: try direct recovery without prefix
        try:
            from eth_account import Account
            message_hash = hashlib.sha3_256(
                b"\x19Ethereum Signed Message:\n" + str(len(message)).encode() + message.encode()
            ).digest()
            # This won't work directly, need proper implementation
            raise HTTPException(status_code=400, detail=f"Signature verification failed: {e}")
        except:
            raise HTTPException(status_code=400, detail=f"Signature verification failed: {e}")

# ── GMGN Integration ───────────────────────────────────────────────────────
def run_gmgn(args: list) -> dict:
    """Run gmgn-cli command"""
    try:
        env = os.environ.copy()
        env["GMGN_API_KEY"] = GMGN_API_KEY
        result = subprocess.run(
            ["gmgn-cli"] + args,
            capture_output=True, text=True, timeout=60, env=env
        )
        if result.returncode == 0 and result.stdout:
            return json.loads(result.stdout)
    except Exception as e:
        print(f"GMGN Error: {e}")
    return None

# ── Pydantic Models ────────────────────────────────────────────────────────
class NonceRequest(BaseModel):
    wallet: str

class NonceResponse(BaseModel):
    nonce: str
    message: str

class VerifyRequest(BaseModel):
    wallet: str
    signature: str

class AuthResponse(BaseModel):
    token: str
    wallet: str

class ClusterSave(BaseModel):
    name: str
    token_address: Optional[str] = None
    token_symbol: Optional[str] = None
    wallets: List[dict]  # [{wallet, profit, pnl_pct}]

class MonitorStart(BaseModel):
    cluster_id: int
    webhook_url: str

# ── Auth Endpoints ─────────────────────────────────────────────────────────
@app.post("/api/auth/nonce", response_model=NonceResponse)
async def get_nonce(req: NonceRequest):
    """Generate nonce for wallet to sign"""
    wallet = req.wallet.lower()
    nonce = secrets.token_hex(16)
    message = f"Sign this message to authenticate with FnF Radar.\n\nWallet: {wallet}\nNonce: {nonce}\nTimestamp: {int(time.time())}"
    
    conn = get_db()
    try:
        conn.execute("""
            INSERT INTO users (wallet_address, nonce, nonce_expires_at)
            VALUES (?, ?, ?)
            ON CONFLICT(wallet_address) DO UPDATE SET
                nonce = excluded.nonce,
                nonce_expires_at = excluded.nonce_expires_at
        """, (wallet, nonce, int(time.time()) + 300))  # 5 min expiry
        conn.commit()
    finally:
        conn.close()
    
    return NonceResponse(nonce=nonce, message=message)

@app.post("/api/auth/verify", response_model=AuthResponse)
async def verify_signature(req: VerifyRequest):
    """Verify signature and return JWT"""
    wallet = req.wallet.lower()
    
    # Get stored nonce
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT nonce, nonce_expires_at FROM users WHERE wallet_address = ?",
            (wallet,)
        ).fetchone()
    finally:
        conn.close()
    
    if not user:
        raise HTTPException(status_code=400, detail="No nonce found. Request a new one.")
    
    if int(time.time()) > user["nonce_expires_at"]:
        raise HTTPException(status_code=400, detail="Nonce expired. Request a new one.")
    
    # Reconstruct the message that was signed
    message = f"Sign this message to authenticate with FnF Radar.\n\nWallet: {wallet}\nNonce: {user['nonce']}\nTimestamp: {user['nonce_expires_at'] - 300}"
    
    # Recover signer from signature
    recovered = recover_signer(message, req.signature)
    
    if recovered != wallet:
        raise HTTPException(status_code=401, detail="Signature does not match wallet")
    
    # Update last login
    conn = get_db()
    try:
        conn.execute(
            "UPDATE users SET last_login_at = ? WHERE wallet_address = ?",
            (int(time.time()), wallet)
        )
        conn.commit()
    finally:
        conn.close()
    
    token = create_jwt(wallet)
    return AuthResponse(token=token, wallet=wallet)

# ── Protected Endpoints ────────────────────────────────────────────────────
@app.get("/api/user/profile")
async def get_profile(wallet: str = Depends(get_current_user)):
    """Get user's profile and clusters"""
    conn = get_db()
    try:
        clusters = conn.execute("""
            SELECT c.*, 
                   COUNT(cw.id) as wallet_count,
                   COALESCE(SUM(cw.profit), 0) as total_profit
            FROM clusters c
            LEFT JOIN cluster_wallets cw ON cw.cluster_id = c.id
            WHERE c.user_wallet = ?
            GROUP BY c.id
            ORDER BY c.created_at DESC
        """, (wallet,)).fetchall()
        
        monitors = conn.execute("""
            SELECT m.*, c.name as cluster_name
            FROM monitors m
            JOIN clusters c ON c.id = m.cluster_id
            WHERE m.user_wallet = ?
            ORDER BY m.created_at DESC
        """, (wallet,)).fetchall()
        
        return {
            "wallet": wallet,
            "clusters": [dict(c) for c in clusters],
            "monitors": [dict(m) for m in monitors]
        }
    finally:
        conn.close()

@app.post("/api/scan")
async def scan_token(request: Request, wallet: str = Depends(get_current_user)):
    """Scan token for profitable traders via GMGN"""
    data = await request.json()
    token = data.get("token", "").strip()
    
    if not token or not token.startswith("0x"):
        raise HTTPException(status_code=400, detail="Valid token address required")
    
    # Get token info
    token_info = run_gmgn(["token", "info", "--chain", CHAIN, "--address", token, "--raw"])
    if not token_info:
        raise HTTPException(status_code=404, detail="Token not found on GMGN")
    
    # Get traders sorted by profit
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
            tags = t.get("tags", [])
            if "sandwich_bot" in tags or "sniper" in tags:
                continue
            trader_list.append({
                "wallet": t.get("address"),
                "profit": t.get("profit", 0),
                "pnl_pct": t.get("realized_pnl", 0),
                "buys": t.get("buy_tx_count_cur", 0),
                "tags": tags,
                "selected": t.get("profit", 0) > 1000
            })
    
    return {
        "token": token_info,
        "traders": trader_list
    }

@app.post("/api/cluster/save")
async def save_cluster(
    req: ClusterSave,
    wallet: str = Depends(get_current_user)
):
    """Save a cluster of wallets"""
    conn = get_db()
    try:
        # Create cluster
        cursor = conn.execute("""
            INSERT INTO clusters (user_wallet, name, token_address, token_symbol)
            VALUES (?, ?, ?, ?)
        """, (wallet, req.name, req.token_address, req.token_symbol))
        cluster_id = cursor.lastrowid
        
        # Add wallets to cluster
        for w in req.wallets:
            conn.execute("""
                INSERT INTO cluster_wallets (cluster_id, wallet_address, profit, pnl_pct)
                VALUES (?, ?, ?, ?)
            """, (cluster_id, w["wallet"], w.get("profit", 0), w.get("pnl_pct", 0)))
        
        conn.commit()
        
        return {
            "status": "ok",
            "cluster_id": cluster_id,
            "wallet_count": len(req.wallets)
        }
    finally:
        conn.close()

@app.get("/api/cluster/{cluster_id}")
async def get_cluster(
    cluster_id: int,
    wallet: str = Depends(get_current_user)
):
    """Get cluster details"""
    conn = get_db()
    try:
        cluster = conn.execute("""
            SELECT * FROM clusters WHERE id = ? AND user_wallet = ?
        """, (cluster_id, wallet)).fetchone()
        
        if not cluster:
            raise HTTPException(status_code=404, detail="Cluster not found")
        
        wallets = conn.execute("""
            SELECT * FROM cluster_wallets WHERE cluster_id = ?
            ORDER BY profit DESC
        """, (cluster_id,)).fetchall()
        
        return {
            "cluster": dict(cluster),
            "wallets": [dict(w) for w in wallets]
        }
    finally:
        conn.close()

@app.delete("/api/cluster/{cluster_id}")
async def delete_cluster(
    cluster_id: int,
    wallet: str = Depends(get_current_user)
):
    """Delete a cluster"""
    conn = get_db()
    try:
        result = conn.execute(
            "DELETE FROM clusters WHERE id = ? AND user_wallet = ?",
            (cluster_id, wallet)
        )
        conn.commit()
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Cluster not found")
        return {"status": "deleted"}
    finally:
        conn.close()

# ── Monitor Endpoints ──────────────────────────────────────────────────────
@app.post("/api/monitor/start")
async def start_monitor(
    req: MonitorStart,
    wallet: str = Depends(get_current_user)
):
    """Start monitoring a cluster for buys"""
    conn = get_db()
    try:
        # Verify cluster belongs to user
        cluster = conn.execute(
            "SELECT id FROM clusters WHERE id = ? AND user_wallet = ?",
            (req.cluster_id, wallet)
        ).fetchone()
        
        if not cluster:
            raise HTTPException(status_code=404, detail="Cluster not found")
        
        # Check if monitor already exists
        existing = conn.execute(
            "SELECT id FROM monitors WHERE cluster_id = ? AND user_wallet = ? AND active = 1",
            (req.cluster_id, wallet)
        ).fetchone()
        
        if existing:
            # Update webhook
            conn.execute(
                "UPDATE monitors SET webhook_url = ? WHERE id = ?",
                (req.webhook_url, existing["id"])
            )
            monitor_id = existing["id"]
        else:
            cursor = conn.execute("""
                INSERT INTO monitors (cluster_id, user_wallet, webhook_url)
                VALUES (?, ?, ?)
            """, (req.cluster_id, wallet, req.webhook_url))
            monitor_id = cursor.lastrowid
        
        conn.commit()
        
        # Start monitoring in background thread
        import threading
        threading.Thread(
            target=monitor_cluster,
            args=(monitor_id, req.cluster_id, req.webhook_url, wallet),
            daemon=True
        ).start()
        
        return {"status": "started", "monitor_id": monitor_id}
    finally:
        conn.close()

@app.post("/api/monitor/stop/{monitor_id}")
async def stop_monitor(
    monitor_id: int,
    wallet: str = Depends(get_current_user)
):
    """Stop monitoring"""
    conn = get_db()
    try:
        conn.execute(
            "UPDATE monitors SET active = 0 WHERE id = ? AND user_wallet = ?",
            (monitor_id, wallet)
        )
        conn.commit()
        return {"status": "stopped"}
    finally:
        conn.close()

def monitor_cluster(monitor_id: int, cluster_id: int, webhook: str, user_wallet: str):
    """Background monitoring loop"""
    last_check = {}
    
    while True:
        conn = get_db()
        try:
            # Check if still active
            monitor = conn.execute(
                "SELECT active FROM monitors WHERE id = ?", (monitor_id,)
            ).fetchone()
            
            if not monitor or not monitor["active"]:
                break
            
            # Get wallets in cluster
            wallets = conn.execute(
                "SELECT * FROM cluster_wallets WHERE cluster_id = ?", (cluster_id,)
            ).fetchall()
            
            for w in wallets:
                wallet_addr = w["wallet_address"]
                try:
                    # Check recent activity
                    activity = run_gmgn([
                        "portfolio", "activity",
                        "--chain", CHAIN,
                        "--wallet", wallet_addr,
                        "--limit", "3",
                        "--raw"
                    ])
                    
                    if activity and activity.get("list"):
                        for act in activity["list"]:
                            ts = act.get("timestamp", "")
                            if wallet_addr not in last_check or last_check[wallet_addr] < ts:
                                last_check[wallet_addr] = ts
                                
                                if act.get("type") == "buy":
                                    token_sym = act.get("token_symbol", "Unknown")
                                    profit = w.get("profit", 0)
                                    pnl = w.get("pnl_pct", 0)
                                    
                                    msg = (
                                        f"**🔔 Buy Alert!**\n"
                                        f"Wallet: `{wallet_addr[:10]}...{wallet_addr[-6:]}`\n"
                                        f"Bought: **{token_sym}**\n"
                                        f"Profit: **${profit:,.0f}** ({pnl*100:.1f}% PnL)"
                                    )
                                    
                                    try:
                                        requests.post(webhook, json={"content": msg}, timeout=10)
                                        conn.execute(
                                            "UPDATE monitors SET last_alert_at = ? WHERE id = ?",
                                            (int(time.time()), monitor_id)
                                        )
                                        conn.commit()
                                    except:
                                        pass
                    
                    time.sleep(1)  # Rate limit
                except Exception as e:
                    print(f"Monitor error for {wallet_addr}: {e}")
                    time.sleep(5)
            
            time.sleep(30)  # Wait between cycles
        finally:
            conn.close()

# ── Health ──────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok", "chain": CHAIN}

@app.get("/", response_class=HTMLResponse)
async def root():
    if os.path.exists("index.html"):
        with open("index.html", "r") as f:
            return f.read()
    return '<html><body><h1>GMGN Cluster Monitor API</h1><p>API is running. <a href="/docs">View Docs</a></p></body></html>'

# ── Main ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
