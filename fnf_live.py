#!/usr/bin/env python3
"""
FnF live watcher - the sniper hook.

Tails LaunchCreated on the factory. For each new launch, waits the 120s
cohort window, pulls the early buyers straight off chain, scores them
against learned rings in data/clusters.json, and prints the signal.

  /usr/bin/python3 fnf_live.py            # dry-run (log signals only)
  /usr/bin/python3 fnf_live.py --buy      # execute buys (wire executor below)

Integration point for the sniper: replace the print in fire() with a call
into seedify-chain-sniper.py's buy executor, sized to ring median spend.
"""
import json, sys, time, urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
CFG = json.load(open(HERE / "fnf_config.json"))
DATA = HERE / "data"
import fnf_backfill as fb
import fnf_signal as fs

DO_BUY = "--buy" in sys.argv
POLL = 3  # sec

def log(m):
    print(f"[FnF-live] {datetime.now(timezone.utc).strftime('%H:%M:%S')} {m}", flush=True)

def main():
    clusters, member_map = fs._load()
    watched = set()
    try:
        watched = set(json.load(open(DATA / "watched.json")))
    except Exception:
        pass
    last = int(fb.rpc("eth_blockNumber", []) or "0x0", 16)
    log(f"watching from block {last}; {sum(1 for c in clusters if c['hit_rate'] >= CFG['signal_min_cluster_hitrate'])} scoreable rings")
    pending = []  # (fire_ts, lid, curve, cb)
    while True:
        head = int(fb.rpc("eth_blockNumber", []) or "0x0", 16)
        if head > last:
            logs = fb.rpc("eth_getLogs", [{"address": CFG["factory"],
                                           "topics": [CFG["launch_event"]],
                                           "fromBlock": hex(last + 1),
                                           "toBlock": hex(head)}]) or []
            for l in logs:
                lid = int(l["topics"][1], 16)
                curve = "0x" + l["topics"][2][-40:]
                if lid in watched:
                    continue
                watched.add(lid)
                pending.append((time.time() + CFG["early_window_seconds"], lid, curve.lower(), int(l["blockNumber"], 16)))
                log(f"new launch #{lid} curve {curve[:10]}… cohort check at +{int(CFG['early_window_seconds'])}s")
            last = head
        now = time.time()
        due = [p for p in pending if p[0] <= now]
        pending = [p for p in pending if p[0] > now]
        for _, lid, curve, cb in due:
            coh = fb.fetch_cohort(curve, cb)
            if not coh:
                continue
            hits = fs.score_cohort(coh)
            json.dump(sorted(watched), open(DATA / "watched.json", "w"))
            if hits:
                h = hits[0]
                log(f"⚡ RING SIGNAL launch #{lid}: ring#{h['cluster']} {h['matched']}/{h['of']} wallets, "
                    f"ring grad-rate {h['hit_rate']:.0%} ({h['lift']}x), cohort {len(coh)} wallets, "
                    f"ring ETH in cohort {h['ring_eth_in_cohort']}")
                if DO_BUY:
                    # TODO: call sniper executor here (sized to h['ring_eth_in_cohort'] median)
                    log("  (buy execution not wired - dry-run)")
            else:
                log(f"launch #{lid}: cohort {len(coh)} wallets, no ring match")
        time.sleep(POLL)

if __name__ == "__main__":
    main()
