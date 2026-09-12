#!/usr/bin/env python3
"""
FnF (Family & Friends) - backfill engine (RPC-only, no explorer).

Reconstructs early buyer cohorts for PAST launches and captures the launch
registry. Loser launches matter as much as winners - they are the negative
training set that keeps clusters honest.

Per launch (2-5 RPC calls):
  1. eth_getLogs factory LaunchCreated, topic1 = padded launchId
     searched in 5M-block windows backwards from head -> creation block
  2. eth_getLogs curve Buy events, creation_block .. +window_blocks
     weight = token amount in log data (price ~ constant at launch start)

Output:
  data/registry.json  launch metadata
  data/cohorts.json   { "launch:<id>": {wallet: tokens_wei, ...} }
Usage: /usr/bin/python3 fnf_backfill.py [--max N] [--redo] [--start-id N]
"""
import json, os, sys, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
CFG = json.load(open(HERE / "fnf_config.json"))
DATA = HERE / "data"; DATA.mkdir(exist_ok=True)
COHORTS_F = DATA / "cohorts.json"
REGISTRY_F = DATA / "registry.json"

RPC = CFG["rpc"]
FACTORY = CFG["factory"]
LEVENT = CFG["launch_event"]
BUY_TOPIC = "0x8a5254432535d4192429d2cc163283a57784eac274295fcda17cc659c1ee414c"
WINDOW_BLOCKS = int(CFG["early_window_seconds"] / CFG.get("block_seconds", 0.132))
MIN_ETH = int(CFG.get("min_cohort_eth", 3e15))   # wei; filters dust buys

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0",
      "Content-Type": "application/json"}

def log(msg):
    print(f"[FnF-backfill] {datetime.now(timezone.utc).strftime('%H:%M:%S')} {msg}", flush=True)

def http(url, body=None, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers=UA)
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())

def get(url):
    return http(url)

def rpc(method, params):
    try:
        r = http(RPC, {"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
        return r.get("result")
    except Exception:
        return None

def pad(addr):
    return "0x" + addr.lower().replace("0x", "").rjust(64, "0")

# ---------- registry ----------
def enumerate_launches(max_n, lifecycle=None):
    out = {}
    cursor = None
    base = CFG["api_base"]
    n_target = max_n
    while len(out) < n_target:
        url = base + "/launches?limit=100"
        if lifecycle:
            url += "&lifecycle=" + lifecycle
        if cursor:
            url += "&cursor=" + urllib.parse.quote(cursor)
        try:
            d = get(url)
        except Exception as e:
            log(f"launches fetch err: {e}"); break
        items = d["data"]["items"]
        if not items:
            break
        for it in items:
            cu = it.get("curve") or {}
            lid = it["launchId"]
            out[lid] = {
                "launch_id": lid,
                "token": it["tokenAddress"].lower(),
                "symbol": (it.get("symbol") or "").strip(),
                "curve": (it.get("curveAddress") or "").lower(),
                "created_at": it.get("createdAt"),
                "lifecycle": cu.get("lifecycle"),
                "raised": int(cu.get("netRaisedWei") or 0),
                "target": int(cu.get("netTargetWei") or 5_000_000_000_000_000_000),
                "graduated_at": cu.get("graduatedAt"),
            }
        page = d["data"].get("page") or {}
        cursor = page.get("nextCursor")
        log(f"registry: {len(out)} launches")
        if not page.get("hasMore"):
            break
        time.sleep(0.2)
    return out

# ---------- cohort ----------
def find_creation_block(lid_int, head, start_window=0):
    """LaunchCreated with topic1 = launch id; search backwards in 5M windows."""
    tp1 = pad(hex(lid_int)[2:].rjust(40, "0") if False else format(lid_int, "x").rjust(40, "0"))
    W = 5_000_000
    w = start_window
    for _ in range(6):
        lo = max(0, head - W * (w + 1)); hi = head - W * w
        r = rpc("eth_getLogs", [{"address": FACTORY,
                                 "topics": [LEVENT, tp1],
                                 "fromBlock": hex(lo), "toBlock": hex(hi)}])
        if r is None:
            log(f"  rpc err win {w}, retry"); time.sleep(3)
            r = rpc("eth_getLogs", [{"address": FACTORY,
                                     "topics": [LEVENT, tp1],
                                     "fromBlock": hex(lo), "toBlock": hex(hi)}])
        if r:
            return int(r[0]["blockNumber"], 16), w
        if lo == 0:
            break
        w += 1
    return None, start_window

def fetch_cohort(curve, cb):
    logs = rpc("eth_getLogs", [{"address": curve, "topics": [BUY_TOPIC],
                                "fromBlock": hex(cb), "toBlock": hex(cb + WINDOW_BLOCKS)}])
    if logs is None:
        return None
    coh = {}
    for l in logs:
        w = "0x" + l["topics"][1][-40:]
        if w.lower() == FACTORY.lower():
            continue  # protocol seed buy - appears in every cohort, poisons edges
        d = l["data"][2:]
        words = [d[i:i+64] for i in range(0, len(d), 64)]
        if not words:
            continue
        eth = int(words[0], 16)          # Buy(buyer, amountWei, ...) - data[0]
        if eth >= MIN_ETH:
            coh[w] = coh.get(w, 0) + eth
    return coh

def main():
    import urllib.parse
    args = sys.argv[1:]
    max_n = CFG["max_launches"]
    redo = "--redo" in args
    for a in args:
        if a.startswith("--max"):
            max_n = int(a.split("=")[1]) if "=" in a else int(args[args.index(a) + 1])

    cohorts = {} if redo else (json.load(open(COHORTS_F)) if COHORTS_F.exists() else {})
    registry = {} if redo else (json.load(open(REGISTRY_F)) if REGISTRY_F.exists() else {})
    reg = enumerate_launches(max_n)
    registry.update(reg)
    grad = enumerate_launches(max_n, lifecycle="GRADUATED")
    log(f"graduated registry: {len(grad)}")
    registry.update(grad)
    json.dump(registry, open(REGISTRY_F, "w"))

    head = int(rpc("eth_blockNumber", []) or "0x0", 16)
    todo = sorted([lid for lid in registry
                   if f"launch:{lid}" not in cohorts and registry[lid]["curve"]],
                  key=int)
    log(f"head {head}, {len(todo)} launches need cohorts, window={WINDOW_BLOCKS} blocks")
    win_hint = 0
    done = 0
    for lid in todo:
        l = registry[lid]
        # launches arrive roughly in block order -> hint window from previous hit
        cb, win_hint = find_creation_block(int(lid), head, max(0, win_hint - 1))
        if not cb:
            log(f"#{lid} creation block not found")
            continue
        coh = fetch_cohort(l["curve"], cb)
        if coh is None:
            log(f"#{lid} cohort fetch failed")
            continue
        cohorts[f"launch:{lid}"] = {
            "wallets": coh, "created_block": cb,
            "symbol": l["symbol"], "lifecycle": l["lifecycle"],
            "raised": l["raised"], "target": l["target"], "created_at": l["created_at"],
        }
        done += 1
        if done % 25 == 0:
            tmp = COHORTS_F.with_suffix(".tmp")
            json.dump(cohorts, open(tmp, "w")); os.replace(tmp, COHORTS_F)
            log(f"saved {done} new cohorts (total {len(cohorts)})")
    tmp = COHORTS_F.with_suffix(".tmp")
    json.dump(cohorts, open(tmp, "w")); os.replace(tmp, COHORTS_F)
    nonempty = sum(1 for v in cohorts.values() if v["wallets"])
    grad = sum(1 for v in cohorts.values() if v["lifecycle"] == "GRADUATED")
    log(f"DONE. {len(cohorts)} launches, {nonempty} non-empty early cohorts, {grad} graduated")

if __name__ == "__main__":
    main()
