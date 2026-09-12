#!/usr/bin/env python3
"""
FnF check - scan begins from a token contract address.

  /usr/bin/python3 fnf_check.py 0x<token_curve_address>

Everything is derived from the address alone:
  1. binary-search the deploy block (first block where eth_getCode != 0x)
  2. eth_getLogs Buy events on it, first 120s window  (launchpad curve)
     or ERC20 Transfers from mint, if it's a plain token
  3. match the cohort against learned rings in data/clusters.json

No launch registry, no launchpad API, no live watching. The address is the
whole job. Point it at any token, known or unknown.
"""
import json, sys, urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
CFG = json.load(open(HERE / "fnf_config.json"))
DATA = HERE / "data"
import fnf_backfill as fb

EXP = CFG["explorer"]
def get(path):
    req = urllib.request.Request(EXP + path, headers={"User-Agent": "Mozilla/5.0"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

BUY_TOPIC = CFG["buy_event"]
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
EXCLUDE = {w.lower() for w in CFG.get("exclude_wallets", [])} | {CFG["factory"].lower()}

def deploy_block(addr):
    # explorer gives the true creation block (RPC prunes historical state,
    # so eth_getCode binary search converges to the node's state floor instead)
    try:
        d = get(f"/addresses/{addr.lower()}")
        h = d.get("creation_transaction_hash")
        if h:
            tx = get(f"/transactions/{h}")
            bn = tx.get("block_number")
            if bn:
                return int(bn)
    except Exception:
        pass
    # fallback: binary search (only reliable within ~20k blocks of head)
    lo, hi = 0, int(fb.rpc("eth_blockNumber", []) or "0x0", 16)
    while lo < hi:
        mid = (lo + hi) // 2
        code = fb.rpc("eth_getCode", [addr, hex(mid)]) or "0x"
        if len(code) > 2:
            hi = mid
        else:
            lo = mid + 1
    return lo

def cohort_from_buys(curve, cb, window):
    logs = fb.rpc("eth_getLogs", [{"address": curve, "topics": [BUY_TOPIC],
                                   "fromBlock": hex(cb), "toBlock": hex(cb + window)}]) or []
    coh = defaultdict(float)
    for l in logs:
        w = "0x" + l["topics"][1][-40:]
        if w.lower() in EXCLUDE:
            continue
        d = l["data"][2:]
        words = [d[i:i+64] for i in range(0, len(d), 64)]
        eth_in = int(words[1], 16) / 1e18 if len(words) > 1 else int(words[0], 16) / 1e18
        if eth_in * 1e18 >= CFG.get("min_cohort_eth", 1e13):
            coh[w.lower()] += eth_in
    return dict(coh)

def cohort_from_transfers(tok, cb, window):
    # early holders = recipients of Transfers where src is the token itself (mint)
    # or the deployer within the window; a crude but launchpad-agnostic proxy
    logs = fb.rpc("eth_getLogs", [{"address": tok, "topics": [TRANSFER_TOPIC],
                                   "fromBlock": hex(cb), "toBlock": hex(cb + window)}]) or []
    coh = defaultdict(float)
    # Find deployer: first transfer's source that isn't the token contract itself
    deployer = None
    for l in logs:
        if len(l["topics"]) < 3:
            continue
        src = "0x" + l["topics"][1][-40:]
        if src.lower() != tok.lower() and src != "0x" + "0" * 40:
            deployer = src.lower()
            break
    for l in logs:
        if len(l["topics"]) < 3:
            continue
        src = "0x" + l["topics"][1][-40:]
        dst = "0x" + l["topics"][2][-40:]
        # Include transfers from token contract (mint) OR from deployer
        if src.lower() == tok.lower() and dst.lower() not in EXCLUDE:
            coh[dst.lower()] += int(l["data"], 16) / 1e18
        elif deployer and src.lower() == deployer and dst.lower() not in EXCLUDE:
            coh[dst.lower()] += int(l["data"], 16) / 1e18
    return dict(coh)

def match_rings(coh):
    clusters = json.load(open(DATA / "clusters.json"))["clusters"]
    member_map = defaultdict(list)
    for i, c in enumerate(clusters):
        if c["hit_rate"] >= CFG["signal_min_cluster_hitrate"] and c["size"] >= CFG["signal_min_members"]:
            for w in c["members"]:
                member_map[w.lower()].append(i)
    tally = defaultdict(lambda: {"m": {}, "eth": 0.0})
    for w, eth in coh.items():
        for ci in member_map.get(w, []):
            tally[ci]["m"][w] = eth
            tally[ci]["eth"] += eth
    hits = []
    for ci, t in tally.items():
        if len(t["m"]) >= CFG["signal_min_members"]:
            c = clusters[ci]
            hits.append({"ring": ci, "matched": len(t["m"]), "of": c["size"],
                         "ring_grad_rate": c["hit_rate"], "ring_avg_lift": c["avg_lift"],
                         "ring_eth_here": round(t["eth"], 4)})
    hits.sort(key=lambda h: h["matched"], reverse=True)
    return hits

def main(addr):
    head = int(fb.rpc("eth_blockNumber", []) or "0x0", 16)
    cb = deploy_block(addr)
    window = int(CFG["early_window_seconds"] / CFG.get("block_seconds", 0.132))
    sym = ""
    try:
        raw = fb.rpc("eth_call", [{"to": addr, "data": "0x95d89b41"}, "latest"]) or "0x"
        if len(raw) > 66:
            n = int(raw[2:66], 16)
            sym = bytes.fromhex(raw[66:66 + n * 2]).decode(errors="replace")
    except Exception:
        pass
    coh = cohort_from_buys(addr, cb, window)
    kind = "curve (Buy events)"
    if not coh:
        coh = cohort_from_transfers(addr, cb, window)
        kind = "token (Transfer mints)"
    hits = match_rings(coh)
    print(f"address:  {addr}  {('@' + sym) if sym else ''}")
    print(f"deployed: block {cb} (head {head})")
    print(f"early window: {CFG['early_window_seconds']}s = {window} blocks, source: {kind}")
    print(f"cohort:   {len(coh)} wallets")
    if hits:
        for h in hits:
            print(f"⚡ RING SIGNAL — ring#{h['ring']}: {h['matched']}/{h['of']} members bought early "
                  f"(ring grad-rate {h['ring_grad_rate']:.0%}, lift {h['ring_avg_lift']}x), "
                  f"{h['ring_eth_here']} ETH in this cohort")
    else:
        print("no ring signal")
    return {"address": addr, "deploy_block": cb, "symbol": sym,
            "cohort_size": len(coh), "hits": hits}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    main(sys.argv[1])
