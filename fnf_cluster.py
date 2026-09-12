#!/usr/bin/env python3
"""
FnF (Family & Friends) - cluster engine.

Reads data/cohorts.json, builds a co-purchase graph, finds rings.

Key design: edges are weighted by LIFT, not raw co-occurrence.
  lift(a,b) = shared / (p_a * p_b * n_launches)
A bot in 257/816 launches sharing 81 launches with another such bot has
lift 1.0 (pure chance) -> no edge. Two wallets in 20 launches each sharing
15 has lift 30 -> real ring. This kills the hairball that raw co-occurrence
produces on a launchpad full of indiscriminate point-farmers.

Output data/clusters.json:
  [{members, size, launches_together, avg_lift, spend_eth,
    hit_launches, good_launches, hit_rate, lift_vs_baseline}]
Usage: /usr/bin/python3 fnf_cluster.py
"""
import json, math
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
CFG = json.load(open(HERE / "fnf_config.json"))
DATA = HERE / "data"

cohorts = json.load(open(DATA / "cohorts.json"))
EXCLUDE = {w.lower() for w in CFG.get("exclude_wallets", [])}
EXCLUDE.add(CFG["factory"].lower())

n = len(cohorts)
launch_wallets = {}
appear = defaultdict(int)
spend = defaultdict(float)
for k, v in cohorts.items():
    ws = {w.lower() for w in v["wallets"]} - EXCLUDE
    launch_wallets[k] = ws
    for w, eth in v["wallets"].items():
        wl = w.lower()
        if wl in EXCLUDE:
            continue
        appear[wl] += 1
        spend[wl] += eth / 1e18

# pair stats
pair_shared = defaultdict(int)
for ws in launch_wallets.values():
    wl = sorted(ws)
    for i in range(len(wl)):
        for j in range(i + 1, len(wl)):
            pair_shared[(wl[i], wl[j])] += 1

MIN_LIFT = CFG.get("min_edge_lift", 4.0)
MIN_SHARED = CFG.get("min_shared_launches", 2)
edges = {}
for (a, b), shared in pair_shared.items():
    if shared < MIN_SHARED:
        continue
    expected = (appear[a] / n) * (appear[b] / n) * n
    if expected <= 0:
        continue
    lift = shared / expected
    if lift >= MIN_LIFT:
        edges[(a, b)] = (shared, lift)

# connected components on lift-filtered edges
adj = defaultdict(set)
for (a, b) in edges:
    adj[a].add(b); adj[b].add(a)
seen, clusters = set(), []
for w in adj:
    if w in seen:
        continue
    comp, stack = set(), [w]
    while stack:
        x = stack.pop()
        if x in comp:
            continue
        comp.add(x); seen.add(x)
        stack.extend(adj[x] - comp)
    clusters.append(comp)

baseline = sum(1 for ws in launch_wallets.values() if any(len(x) > 1 for x in [ws])) / n
grad = {k for k, v in cohorts.items() if v["lifecycle"] == "GRADUATED"}

out = []
for comp in clusters:
    members = sorted(comp)
    e = [(s, l) for (a, b), (s, l) in edges.items() if a in comp and b in comp]
    hit = [k for k, ws in launch_wallets.items() if len(ws & comp) >= CFG["signal_min_members"]]
    good = [k for k in hit if k in grad]
    out.append({
        "members": members,
        "size": len(members),
        "launches_together": sum(s for s, _ in e),
        "avg_lift": round(sum(l for _, l in e) / max(len(e), 1), 1),
        "spend_eth": round(sum(spend[m] for m in members), 3),
        "hit_launches": len(hit),
        "good_launches": [k.replace("launch:", "") + ":" + cohorts[k]["symbol"] for k in good],
        "hit_rate": round(len(good) / max(len(hit), 1), 3),
        "lift_vs_baseline": round((len(good) / max(len(hit), 1)) / max(baseline, 0.01), 2),
    })
out.sort(key=lambda c: c["hit_rate"] * c["size"], reverse=True)
json.dump({"generated_from": n, "baseline_grad_rate": round(baseline, 3), "clusters": out},
          open(DATA / "clusters.json", "w"))

print(f"{n} launches, grad rate {baseline:.1%}, {len(out)} clusters "
      f"(min lift {MIN_LIFT}, min shared {MIN_SHARED})")
for i, c in enumerate(out[:10]):
    print(f"\nRING #{i} size={c['size']} lift={c['avg_lift']}x "
          f"spend={c['spend_eth']}ETH hits={c['hit_launches']} "
          f"grad-rate={c['hit_rate']:.0%} ({c['lift_vs_baseline']}x baseline)")
    print("  members:", [m[:10] for m in c["members"][:12]])
    print("  graduated together:", c["good_launches"][:8])
