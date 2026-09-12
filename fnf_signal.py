#!/usr/bin/env python3
"""
FnF live signal - match a NEW launch's early cohort against learned clusters.

  Standalone test:  /usr/bin/python3 fnf_signal.py <launch_id>
  Replay mode:      /usr/bin/python3 fnf_signal.py
  From the sniper:  from fnf_signal import fnf_signal; sig, detail = fnf_signal(lid)

A "hit" = >= signal_min_members wallets from the SAME learned cluster bought
inside the launch's first 120s. Individual wallets are disposable (Vibe Batch
burns one address per launch); the co-purchase RING is what persists.
"""
import json, sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
CFG = json.load(open(HERE / "fnf_config.json"))
DATA = HERE / "data"

def _load():
    clusters = json.load(open(DATA / "clusters.json"))["clusters"]
    member_to_clusters = defaultdict(list)
    for i, c in enumerate(clusters):
        if c["hit_rate"] >= CFG["signal_min_cluster_hitrate"] and c["size"] >= CFG["signal_min_members"]:
            for w in c["members"]:
                member_to_clusters[w.lower()].append(i)
    return clusters, member_to_clusters

def score_cohort(cohort_wallets):
    """cohort_wallets: {wallet: eth_wei} from a NEW launch's early window.
    Returns hits sorted by strength: [{cluster, matched, of, hit_rate, ...}]."""
    clusters, member_map = _load()
    tally = defaultdict(lambda: {"members": {}, "eth": 0})
    for w, eth in cohort_wallets.items():
        wl = w.lower()
        for ci in member_map.get(wl, []):
            tally[ci]["members"][wl] = eth
            tally[ci]["eth"] += eth
    hits = []
    for ci, t in tally.items():
        if len(t["members"]) >= CFG["signal_min_members"]:
            c = clusters[ci]
            hits.append({
                "cluster": ci,
                "matched": len(t["members"]),
                "of": c["size"],
                "hit_rate": c["hit_rate"],
                "lift": c["lift_vs_baseline"],
                "ring_prev_graduates": c["good_launches"][-5:],
                "ring_eth_in_cohort": round(t["eth"] / 1e18, 4),
            })
    hits.sort(key=lambda h: h["matched"] * max(h["hit_rate"], 0.01), reverse=True)
    return hits

def live_cohort(launch_id):
    """Fetch a launch's early cohort straight from chain (no cache)."""
    import fnf_backfill as fb
    reg = json.load(open(DATA / "registry.json"))
    lid = str(launch_id)
    meta = reg.get(lid)
    if not meta:
        # brand-new launch: read from API detail? fall back to cohort-less
        return None, {"error": f"launch {lid} not in registry"}
    head = int(fb.rpc("eth_blockNumber", []) or "0x0", 16)
    cb, _ = fb.find_creation_block(int(lid), head)
    if not cb:
        return None, {"error": "creation block not found"}
    coh = fb.fetch_cohort(meta["curve"], cb)
    return coh, {"created_block": cb, "curve": meta["curve"], "symbol": meta["symbol"]}

def fnf_signal(launch_id):
    coh, meta = live_cohort(launch_id)
    if coh is None:
        return False, meta
    hits = score_cohort(coh)
    return bool(hits), {"meta": meta, "cohort_size": len(coh), "hits": hits}

if __name__ == "__main__":
    if len(sys.argv) > 1:
        sig, detail = fnf_signal(sys.argv[1])
        print(json.dumps({"signal": sig, **detail}, indent=1))
    else:
        # replay: known graduates (want signal) vs known losers (want silence)
        cohorts = json.load(open(DATA / "cohorts.json"))
        good = [k for k, v in cohorts.items() if v["lifecycle"] == "GRADUATED"]
        dead = [k for k, v in cohorts.items() if v["lifecycle"] != "GRADUATED"]
        print(f"launches: {len(good)} graduated, {len(dead)} non-graduated\n")
        tp = fp = fn = tn = 0
        for k in good:
            h = score_cohort(cohorts[k]["wallets"])
            tp += bool(h); fn += not h
        for k in dead:
            h = score_cohort(cohorts[k]["wallets"])
            fp += bool(h); tn += not h
        print(f"GRADUATED launches with FnF signal: {tp}/{len(good)}")
        print(f"LOSER launches falsely flagged:     {fp}/{len(dead)}")
        print("\n-- top graduated --")
        for k in good[:6]:
            h = score_cohort(cohorts[k]["wallets"])
            print(f"{k} ({cohorts[k]['symbol']}): {h if h else 'no signal'}")
