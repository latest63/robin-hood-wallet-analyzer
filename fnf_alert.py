#!/usr/bin/env python3
"""
FnF Radar - cluster-buy alert daemon.

Better than a single-wallet alert: watches ALL learned ring wallets at once.
When >= signal_min_members wallets from the same ring buy the SAME token
curve within the rolling 120s window, that's a coordinated family-and-friends
entry - alert it, scored 0-100.

  python3 fnf_alert.py                  # dry-run (log only)
  python3 fnf_alert.py --webhook URL    # or DISCORD_WEBHOOK_URL env / config

Flow:
  poll eth_getLogs for every Buy event chain-wide (one query per tick)
  -> match buyer against ring set -> per-curve ring tally in sliding window
  -> fire scored alert on threshold, auto-escalate if the ring keeps piling in
  -> at window close, enrich: full early cohort + ring overlap via fnf_check
"""
import json, os, sys, time, threading
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
CFG = json.load(open(HERE / "fnf_config.json"))
DATA = HERE / "data"
import fnf_backfill as fb

BUY_TOPIC = CFG["buy_event"]
RING = set(json.load(open(DATA / "ring0.json"))["members"])
RING_META = json.load(open(DATA / "clusters.json"))["clusters"][0]
WINDOW_S = CFG["early_window_seconds"]
MIN_MEMBERS = CFG["signal_min_members"]
STATE_F = DATA / "alert_state.json"
EXPL = CFG["explorer"].rsplit("/api", 1)[0]

WEBHOOK = None
for i, a in enumerate(sys.argv):
    if a == "--webhook" and i + 1 < len(sys.argv):
        WEBHOOK = sys.argv[i + 1]
WEBHOOK = WEBHOOK or os.environ.get("DISCORD_WEBHOOK_URL") or CFG.get("discord_webhook") or None

def log(m):
    print(f"[FnF-radar] {datetime.now(timezone.utc).strftime('%H:%M:%S')} {m}", flush=True)

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

def score_event(matched, hit_rate):
    """0-100: member count saturates at 8, multiplied by ring precision."""
    return round(100 * min(1.0, matched / 8.0) * (0.3 + 0.7 * hit_rate))

def tier(s):
    return "🔴" if s >= 75 else ("🟠" if s >= 50 else "🟡")

def send_discord(payload):
    if not WEBHOOK:
        return
    try:
        import urllib.request
        req = urllib.request.Request(WEBHOOK, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json",
                                              "User-Agent": "FnF-Radar/1.0 (chain-monitor)"})
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        log(f"webhook err: {e}")

def post_alert(curve, matched_map, escalate=False):
    eth = sum(matched_map.values())
    s = score_event(len(matched_map), RING_META["hit_rate"])
    names = ", ".join(f"`{w[:8]}…` ({v:.4f})" for w, v in
                      sorted(matched_map.items(), key=lambda kv: -kv[1])[:8])
    title = f"{tier(s)} Ring buy detected{' (escalation)' if escalate else ''} — score {s}/100"
    embed = {
        "username": "FnF — Family & Friends Radar",
        "embeds": [{
            "title": title,
            "url": f"{EXPL}/address/{curve}",
            "color": 0xFF3B30 if s >= 75 else 0xFF9F0A,
            "fields": [
                {"name": "Curve / token", "value": f"[`{curve[:14]}…`]({EXPL}/address/{curve})"},
                {"name": "Ring wallets", "value": f"**{len(matched_map)}** of {RING_META['size']} in-window · {eth:.4f} ETH"},
                {"name": "Wallets (ETH in)", "value": names or "—"},
                {"name": "Ring track record", "value": f"{RING_META['hit_rate']:.0%} grad-rate · {RING_META['avg_lift']}x lift · 284/284 held-out"},
                {"name": "Why it fired", "value": f"≥{MIN_MEMBERS} ring members bought the SAME curve within {int(WINDOW_S)}s"},
            ],
            "footer": {"text": "FnF radar — cluster signal, not wallet signal"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }],
    }
    log(f"{title}  curve={curve}  matched={len(matched_map)}  eth={eth:.4f}")
    with open(DATA / "alerts.log", "a") as f:
        f.write(json.dumps({"ts": time.time(), "curve": curve, "matched": matched_map,
                            "score": s, "escalate": escalate}) + "\n")
    send_discord(embed)

def enrich(curve):
    """At window close: full early cohort from deploy + ring overlap."""
    try:
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            import fnf_check as fc
            res = fc.main(curve)
        hits = res.get("hits", [])
        s = score_event(hits[0]["matched"] if hits else 0, RING_META["hit_rate"])
        log(f"enriched {curve}: cohort={res['cohort_size']} signal={'yes' if hits else 'no'}")
        fields = [{"name": "Early cohort (120s)", "value": f"{res['cohort_size']} wallets"}]
        if hits:
            h = hits[0]
            fields.append({"name": "Full-window ring match",
                           "value": f"{tier(s)} {h['matched']}/{h['of']} ring members · {h['ring_eth_here']} ETH"})
        send_discord({"username": "FnF — Family & Friends Radar",
                      "embeds": [{"title": f"📋 Cohort report — {curve[:14]}…",
                                  "url": f"{EXPL}/address/{curve}",
                                  "fields": fields,
                                  "timestamp": datetime.now(timezone.utc).isoformat()}]})
    except Exception as e:
        log(f"enrich failed for {curve}: {e}")

def main():
    st = {"last_block": None, "fired": {}}
    if STATE_F.exists():
        try:
            st = json.load(open(STATE_F))
        except Exception:
            pass
    head = int(rpc("eth_blockNumber", []) or "0x0", 16)
    if st["last_block"] is None or head - st["last_block"] > 5000:
        st["last_block"] = head - 300  # ~40s lookback on fresh start
    events = defaultdict(deque)   # curve -> [(ts, wallet, eth)] ring buys only
    fired = st["fired"]           # curve -> {score, matched, enrich_at}
    log(f"start block {st['last_block']}, ring size {len(RING)}, "
        f"webhook={'on' if WEBHOOK else 'OFF (log-only)'}")

    while True:
        try:
            head = int(rpc("eth_blockNumber", []) or "0x0", 16)
            frm = st["last_block"] + 1
            if head >= frm:
                hb = rpc("eth_getBlockByNumber", [hex(head), False])
                hts = int(hb["timestamp"], 16) if hb else time.time()
                def bts(bn, hts=hts, head=head):  # stable ~0.132s/block chain
                    return hts + (bn - head) * CFG.get("block_seconds", 0.132)
                for lo in range(frm, min(head, frm + 4000) + 1, 2000):
                    logs = rpc("eth_getLogs", [{"topics": [BUY_TOPIC],
                                                "fromBlock": hex(lo),
                                                "toBlock": hex(min(lo + 1999, head))}]) or []
                    for l in logs:
                        buyer = ("0x" + l["topics"][1][-40:]).lower()
                        if buyer not in RING:
                            continue
                        bn = int(l["blockNumber"], 16)
                        d = l["data"][2:]
                        words = [d[i:i+64] for i in range(0, len(d), 64)]
                        eth_in = int(words[1], 16) / 1e18 if len(words) > 1 else 0
                        events[l["address"].lower()].append((bts(bn), buyer, eth_in))
                st["last_block"] = min(head, frm + 4000)
                json.dump(st, open(STATE_F, "w"))

            now = time.time()
            for curve, dq in list(events.items()):
                while dq and now - dq[0][0] > WINDOW_S:
                    dq.popleft()
                if not dq:
                    continue
                matched = {}
                for ts, w, e in dq:
                    matched[w] = matched.get(w, 0) + e
                if len(matched) < MIN_MEMBERS:
                    continue
                prev = fired.get(curve)
                s = score_event(len(matched), RING_META["hit_rate"])
                if not prev:
                    post_alert(curve, matched)
                    fired[curve] = {"score": s, "matched": len(matched),
                                    "enrich_at": dq[-1][0] + WINDOW_S + 5}
                elif len(matched) >= prev["matched"] + 2:
                    post_alert(curve, matched, escalate=True)
                    fired[curve] = {"score": s, "matched": len(matched),
                                    "enrich_at": prev["enrich_at"]}
            for curve in list(fired):
                if fired[curve]["enrich_at"] <= now:
                    del fired[curve]
                    threading.Thread(target=enrich, args=(curve,), daemon=True).start()
            st["fired"] = fired
        except Exception as e:
            log(f"tick error: {type(e).__name__}: {e}")
        time.sleep(6)

if __name__ == "__main__":
    main()
