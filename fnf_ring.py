#!/usr/bin/env python3
"""
FnF Ring Monitor - contract-address driven. No launch/curve watching.

You give a contract address. We derive its ring (the wallets that showed up
in its first 5 min) FROM that contract, fold them into ONE consolidated
ring, score it (recurrence-weighted), and monitor THOSE wallet addresses
for future buys. The contract is the only entry point.

  python3 fnf_ring.py add <contract> [label]   # derive + fold in + score
  python3 fnf_ring.py list                      # show the current ring
  python3 fnf_ring.py score                     # recompute / print score
  python3 fnf_ring.py monitor                   # watch the ring wallets
"""
import json, os, sys, time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
CFG = json.load(open(HERE / "fnf_config.json"))
DATA = HERE / "data"
import fnf_backfill as fb
from fnf_check import (deploy_block, BUY_TOPIC, cohort_from_buys,
                       cohort_from_transfers)

EXPL = CFG["explorer"].rsplit("/api", 1)[0]
STORE_F = DATA / "ring_monitor.json"
STATE_F = DATA / "ring_alert_state.json"
WEBHOOK = CFG.get("discord_webhook") or os.environ.get("DISCORD_WEBHOOK_URL")
WINDOW_S = CFG["early_window_seconds"]
MIN_MEMBERS = CFG.get("ring_alert_min", 2)

# ---- past-performance ledger (per-wallet graduation history) ----
def load_ledger():
    try:
        reg = json.load(open(DATA / "registry.json"))
        coh = json.load(open(DATA / "cohorts.json"))
    except Exception:
        return {}
    led = {}
    for lid, v in reg.items():
        key = f"launch:{lid}"
        c = coh.get(key) or {}
        ws = c.get("wallets") if isinstance(c, dict) else None
        if not ws and isinstance(c, dict) and any(k.startswith("0x") for k in c):
            ws = c
        if not ws:
            continue
        grad = v.get("lifecycle") == "GRADUATED"
        for w in ws:
            wl = w.lower()
            r = led.setdefault(wl, [0, 0])
            r[0] += 1
            if grad:
                r[1] += 1
    return led

LEDGER = load_ledger()

def log(m):
    print(f"[FnF-ring] {datetime.now(timezone.utc).strftime('%H:%M:%S')} {m}", flush=True)

def rpc(method, params, tries=5, delay=1.5):
    for _ in range(tries):
        try:
            r = fb.rpc(method, params)
            if r is not None:
                return r
        except Exception:
            pass
        time.sleep(delay)
    return None

def derive_ring(addr):
    """Wallets tied to this contract in its first 5 min (proven fnf_check filter:
    excludes factory seed + dust). Falls back to ERC-20 Transfer mints."""
    cb = deploy_block(addr)
    if cb is None:
        return None, "no deploy block (not a contract?)"
    end = cb + int(WINDOW_S / CFG.get("block_seconds", 0.117))
    cohort = cohort_from_buys(addr, cb, end)
    if not cohort:
        cohort = cohort_from_transfers(addr, cb, end)
    return dict(cohort), cb

def get_all_swaps_for_wallet(wallet_addr, from_block, to_block):
    """Get all Swap events involving a specific wallet."""
    SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
    wallet_lower = wallet_addr.lower()
    
    payload = {"jsonrpc":"2.0","method":"eth_getLogs","params":[{
        "fromBlock": hex(from_block),
        "toBlock": hex(to_block),
        "topics": [SWAP_TOPIC]
    }],"id":1}
    try:
        resp = fb.rpc_raw(json.dumps(payload).encode(), HEADERS)
        if resp is None:
            return []
        logs = json.loads(resp)["result"]
    except:
        return []
    
    swaps = []
    for s in logs:
        topics = s.get("topics", [])
        sender = ("0x" + topics[1][-40:]).lower() if len(topics) > 1 else ""
        recipient = ("0x" + topics[2][-40:]).lower() if len(topics) > 2 else ""
        
        if sender == wallet_lower or recipient == wallet_lower:
            swaps.append(s)
    
    return swaps

def load_store():
    if STORE_F.exists():
        try:
            return json.load(open(STORE_F))
        except Exception:
            pass
    return {"wallets": {}, "contracts": {}}

def save_store(s):
    json.dump(s, open(STORE_F, "w"), indent=1)

def add_contract(addr, label=None):
    cohort, cb = derive_ring(addr)
    if cohort is None:
        return None, cb
    s = load_store()
    excluded = {x.lower() for x in CFG.get("exclude_wallets", [])}
    ckey = addr.lower()
    seen = []
    for w, eth in cohort.items():
        if w in excluded:
            continue
        seen.append(w)
        rec = s["wallets"].setdefault(w, {"contracts": [], "eth": 0.0, "appearances": 0})
        if ckey not in rec["contracts"]:
            rec["contracts"].append(ckey)
            rec["appearances"] = len(rec["contracts"])
        rec["eth"] += eth
    s["contracts"][ckey] = {
        "label": label or (cb and f"deploy#{cb}"),
        "ring_size": len(seen),
        "eth": round(sum(cohort.values()), 6),
        "deploy_block": cb,
    }
    save_store(s)
    sc = score_ring(s)
    return {"contract": ckey, "ring_size": len(seen),
            "total_ring_wallets": len(s["wallets"]), "score": sc}, None

def score_ring(s):
    """Recurrence-weighted: a wallet that recurs across YOUR contracts is a
    stronger 'family' signal than a one-off. Recurring wallets dominate."""
    wallets = s["wallets"]
    size = len(wallets)
    if size == 0:
        return 0.0
    recur = sum(1 for w in wallets.values() if w["appearances"] > 1)
    recur_frac = recur / size
    total_eth = sum(w["eth"] for w in wallets.values())
    size_s = min(size, 40) / 40 * 35
    recur_s = recur_frac * 45
    eth_s = min(total_eth, 2.0) / 2.0 * 20
    return round(size_s + recur_s + eth_s, 1)

def send_discord(payload):
    if not WEBHOOK:
        return
    try:
        import urllib.request
        req = urllib.request.Request(WEBHOOK, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json",
                                              "User-Agent": "FnF-Ring/1.0"})
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        log(f"webhook err: {e}")

def monitor():
    s = load_store()
    ring = set(s["wallets"])
    if not ring:
        log("ring empty - add a contract first"); return
    log(f"monitoring {len(ring)} ring wallets for SWAP events (webhook={'on' if WEBHOOK else 'off'})")
    st = {"last_block": None}
    events = defaultdict(deque)
    if STATE_F.exists():
        try:
            st = json.load(open(STATE_F))
        except Exception:
            pass
    head = int(rpc("eth_blockNumber", []) or "0x0", 16)
    # Start from recent blocks to catch current activity
    if st["last_block"] is None or head - st["last_block"] > 5000:
        st["last_block"] = head - 1000  # Scan last 1000 blocks for history
    
    SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
    
    while True:
        try:
            head = int(rpc("eth_blockNumber", []) or "0x0", 16)
            frm = st["last_block"] + 1
            if head >= frm:
                # Query in chunks to avoid rate limits
                for lo in range(frm, min(head, frm + 2000) + 1, 1000):
                    payload = {"jsonrpc":"2.0","method":"eth_getLogs","params":[{
                        "fromBlock": hex(lo),
                        "toBlock": hex(min(lo + 999, head)),
                        "topics": [SWAP_TOPIC]
                    }],"id":1}
                    logs = rpc("eth_getLogs", [{"topics": [SWAP_TOPIC],
                        "fromBlock": hex(lo), "toBlock": hex(min(lo + 999, head))}]) or []
                    for l in logs:
                        topics = l.get("topics", [])
                        sender = ("0x" + topics[1][-40:]).lower() if len(topics) > 1 else ""
                        recipient = ("0x" + topics[2][-40:]).lower() if len(topics) > 2 else ""
                        
                        # Check if any ring wallet is involved
                        for w in ring:
                            wl = w.lower()
                            if sender == wl or recipient == wl:
                                events[l["address"].lower()].append((time.time(), wl, l))
                
                st["last_block"] = min(head, frm + 2000)
                json.dump(st, open(STATE_F, "w"))
            
            now = time.time()
            for pair_addr, dq in list(events.items()):
                # Clean old events (older than WINDOW_S seconds)
                while dq and now - dq[0][0] > WINDOW_S:
                    dq.popleft()
                if not dq:
                    continue
                
                # Collect unique ring wallets involved
                members = {x[1] for x in dq}
                if len(members) < MIN_MEMBERS:
                    continue
                
                post_swap_alert(pair_addr, members, s, dq)
                events.pop(pair_addr, None)
        except Exception as e:
            log(f"tick err: {e}")
        time.sleep(6)

def post_ring_alert(contract, members, store):
    # "what they bought": pull symbol/status from registry + cohorts
    label = None
    for c, meta in store["contracts"].items():
        if c == contract:
            label = meta.get("label")
            break
    # ring composition: recurring vs one-off within this monitor set
    recur = [m for m in members if store["wallets"].get(m, {}).get("appearances", 0) > 1]
    oneoff = [m for m in members if m not in recur]
    # per-wallet past performance from ledger
    rows = []
    for m in sorted(members, key=lambda w: -store["wallets"].get(w, {}).get("appearances", 0)):
        r = LEDGER.get(m)
        if r and r[0]:
            hist = f"{r[1]}/{r[0]} grad ({round(100*r[1]/r[0])}%)"
        else:
            hist = "no track record"
        app = store["wallets"].get(m, {}).get("appearances", 1)
        tag = "🔁recurring" if app > 1 else "new"
        rows.append(f"`{m[:10]}…` {tag} · {hist}")
    body = "\n".join(rows[:12])
    if len(rows) > 12:
        body += f"\n… +{len(rows)-12} more"
    score = score_ring(store)
    recur_pct = round(100 * len(recur) / max(1, len(members)))
    embed = {
        "username": "FnF — Family & Friends Ring",
        "embeds": [{
            "title": f"👀 Your ring is buying — {len(members)} wallets",
            "url": f"{EXPL}/address/{contract}",
            "color": 0xFF9F0A,
            "fields": [
                {"name": "What they bought",
                 "value": f"[{label or 'contract'}]({EXPL}/address/{contract})\n`{contract[:20]}…`"},
                {"name": "Ring composition",
                 "value": f"**{len(members)}** active · {len(recur)} recurring ({recur_pct}%) · {len(oneoff)} new"},
                {"name": "Ring score", "value": f"{score}/100 (recurrence-weighted)"},
                {"name": "Wallets — history",
                 "value": body or "—"},
            ],
            "footer": {"text": "FnF ring monitor — contract-driven, no launch watching"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }],
    }
    log(f"RING ALERT {contract[:12]} members={len(members)} recur={len(recur)} score={score}")
    send_discord(embed)

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "add":
        addr = sys.argv[2]
        label = sys.argv[3] if len(sys.argv) > 3 else None
        res, err = add_contract(addr, label)
        if err:
            log(f"add failed: {err}")
        else:
            log(f"added {res['contract']}: this cohort={res['ring_size']} wallets, "
                f"ring now={res['total_ring_wallets']} wallets, score={res['score']}/100")
    elif cmd == "list":
        s = load_store()
        log(f"ring: {len(s['wallets'])} wallets across {len(s['contracts'])} contracts")
        for w, r in sorted(s["wallets"].items(), key=lambda kv: -kv[1]["eth"])[:10]:
            log(f"  {w[:14]}… eth={r['eth']:.4f} in {r['appearances']} contract(s)")
    elif cmd == "score":
        s = load_store()
        log(f"ring score = {score_ring(s)}/100  ({len(s['wallets'])} wallets)")
    elif cmd == "monitor":
        monitor()
    else:
        log("usage: add <contract> [label] | list | score | monitor")

if __name__ == "__main__":
    main()
