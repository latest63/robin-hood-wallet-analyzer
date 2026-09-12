#!/usr/bin/env python3
"""
FnF Ring Monitor - SOLANA edition. Contract-address driven. No launch watching.

You give a Solana token mint address. We derive its ring (wallets that received
the token in its first 5 min) FROM that mint, fold all mints' wallets into ONE
consolidated ring, score it (recurrence-weighted), and monitor THOSE wallet
addresses for future buys. The mint is the only entry point.

  python3 fnf_ring_sol.py add <mint> [label]   # derive + fold in + score
  python3 fnf_ring_sol.py list                 # show the current ring
  python3 fnf_ring_sol.py score                # recompute / print score
  python3 fnf_ring_sol.py monitor              # watch the ring wallets

NOTE: live monitoring polls getSignaturesForAddress per ring wallet. Public RPC
rate-limits hard - for continuous monitoring use a paid RPC (Helius/QuickNode)
via SOLANA_RPC env var.
"""
import json, os, sys, time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
CFG = json.load(open(HERE / "fnf_config.json"))
DATA = HERE / "data"

SOL_RPC = os.environ.get("SOLANA_RPC", "https://api.mainnet-beta.solana.com")
EXPL = "https://solscan.io"
STORE_F = DATA / "ring_sol.json"
STATE_F = DATA / "ring_sol_alert_state.json"
WEBHOOK = CFG.get("discord_webhook") or os.environ.get("DISCORD_WEBHOOK_URL")
WINDOW_S = CFG.get("early_window_seconds", 300)
MIN_MEMBERS = CFG.get("ring_alert_min", 2)
SIG_CAP = int(os.environ.get("SOL_SIG_CAP", "80"))   # bounded Proof-of-concept cap

def log(m):
    print(f"[FnF-sol] {datetime.now(timezone.utc).strftime('%H:%M:%S')} {m}", flush=True)

def rpc(method, params, tries=4, delay=1.2):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                       "params": params}).encode()
    for _ in range(tries):
        try:
            import urllib.request
            req = urllib.request.Request(SOL_RPC, data=body,
                headers={"Content-Type": "application/json"})
            r = json.loads(urllib.request.urlopen(req, timeout=25).read())
            if "error" in r:
                log(f"rpc err {method}: {r['error']}")
                if _ < tries - 1:
                    time.sleep(delay); continue
                return None
            return r.get("result")
        except Exception as e:
            time.sleep(delay)
    return None

def mint_authority(mint):
    info = rpc("getAccountInfo", [mint, {"encoding": "jsonParsed"}])
    try:
        return info["data"]["parsed"]["info"]["mintAuthority"].lower()
    except Exception:
        return None

def buyers_in_tx(tx, mint, authority):
    meta = (tx or {}).get("meta") or {}
    pre = {b["owner"].lower(): int(b["uiTokenAmount"]["amount"])
           for b in meta.get("preTokenBalances", [])
           if b.get("mint") == mint and b.get("owner")}
    post = {b["owner"].lower(): int(b["uiTokenAmount"]["amount"])
            for b in meta.get("postTokenBalances", [])
            if b.get("mint") == mint and b.get("owner")}
    res = []
    for w, post_amt in post.items():
        if w == authority:
            continue
        pre_amt = pre.get(w, 0)
        if post_amt > pre_amt:
            res.append((w, max(post_amt - pre_amt, 1)))
    return res

def derive_ring(mint):
    authority = mint_authority(mint)
    sigs = rpc("getSignaturesForAddress", [mint, {"limit": 1000}]) or []
    if not sigs:
        return None, "no signatures (empty mint / bad RPC)"
    sigs_asc = list(reversed(sigs))           # oldest first
    first = sigs_asc[0]
    creation = first.get("blockTime")
    if creation is None:
        creation = rpc("getBlockTime", [first["slot"]])
    if not creation:
        return None, "cannot resolve creation time"
    end = creation + WINDOW_S
    cohort = {}
    scanned = 0
    for s in sigs_asc:
        bt = s.get("blockTime")
        if bt is None:
            bt = rpc("getBlockTime", [s["slot"]])
        if bt is None:
            continue
        if bt < creation:
            continue
        if bt > end:
            break
        if scanned >= SIG_CAP:
            break
        scanned += 1
        tx = rpc("getTransaction", [s["signature"],
                   {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}])
        if not tx:
            continue
        for w, amt in buyers_in_tx(tx, mint, authority):
            cohort[w] = cohort.get(w, 0) + 1   # count of buys (membership)
    return dict(cohort), first["slot"]

def load_store():
    if STORE_F.exists():
        try:
            return json.load(open(STORE_F))
        except Exception:
            pass
    return {"wallets": {}, "mints": {}}

def save_store(s):
    json.dump(s, open(STORE_F, "w"), indent=1)

def add_mint(mint, label=None):
    cohort, slot = derive_ring(mint)
    if cohort is None:
        return None, slot
    s = load_store()
    ckey = mint
    seen = []
    for w in cohort:
        seen.append(w)
        rec = s["wallets"].setdefault(w, {"mints": [], "buys": 0, "appearances": 0})
        if ckey not in rec["mints"]:
            rec["mints"].append(ckey)
            rec["appearances"] = len(rec["mints"])
        rec["buys"] += 1
    s["mints"][ckey] = {"label": label or f"slot#{slot}",
                        "ring_size": len(seen), "creation_slot": slot}
    save_store(s)
    sc = score_ring(s)
    return {"mint": ckey, "ring_size": len(seen),
            "total_ring_wallets": len(s["wallets"]), "score": sc}, None

def score_ring(s):
    wallets = s["wallets"]
    size = len(wallets)
    if size == 0:
        return 0.0
    recur = sum(1 for w in wallets.values() if w["appearances"] > 1)
    recur_frac = recur / size
    buys = sum(w["buys"] for w in wallets.values())
    size_s = min(size, 40) / 40 * 35
    recur_s = recur_frac * 45
    buy_s = min(buys, 80) / 80 * 20
    return round(size_s + recur_s + buy_s, 1)

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
        log("ring empty - add a mint first"); return
    log(f"monitoring {len(ring)} ring wallets on Solana (rpc={SOL_RPC[:40]}… "
        f"webhook={'on' if WEBHOOK else 'off'})")
    log("NOTE: public RPC will rate-limit; use paid RPC for continuous run.")
    seen = {}   # wallet -> last signature we processed
    while True:
        try:
            for w in list(ring):
                sigs = rpc("getSignaturesForAddress", [w, {"limit": 20}]) or []
                if not sigs:
                    continue
                latest = sigs[0]["signature"]
                if seen.get(w) == latest:
                    continue
                for sgn in sigs:
                    if seen.get(w) == sgn["signature"]:
                        break
                    tx = rpc("getTransaction", [sgn["signature"],
                               {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}])
                    bought = new_tokens_in_tx(tx, w)
                    for mint in bought:
                        if mint in ring:
                            continue
                        post_ring_alert(mint, {w}, s, extra=f"wallet {w[:8]}… bought")
                seen[w] = latest
        except Exception as e:
            log(f"tick err: {e}")
        time.sleep(10)

def new_tokens_in_tx(tx, wallet):
    meta = (tx or {}).get("meta") or {}
    pre = {b["mint"]: int(b["uiTokenAmount"]["amount"])
           for b in meta.get("preTokenBalances", []) if b.get("owner","").lower() == wallet}
    post = {b["mint"]: int(b["uiTokenAmount"]["amount"])
            for b in meta.get("postTokenBalances", []) if b.get("owner","").lower() == wallet}
    return [m for m, a in post.items() if a > pre.get(m, 0)]

def post_ring_alert(mint, members, store, extra=""):
    members = list(members)
    label = None
    for c, meta in store["mints"].items():
        if c == mint:
            label = meta.get("label")
            break
    recur = [m for m in members if store["wallets"].get(m, {}).get("appearances", 0) > 1]
    body = "\n".join(f"`{m[:10]}…` {'🔁recurring' if m in recur else 'new'}"
                     for m in members[:12])
    if len(members) > 12:
        body += f"\n… +{len(members)-12} more"
    score = score_ring(store)
    embed = {
        "username": "FnF — Family & Friends Ring (Solana)",
        "embeds": [{
            "title": f"👀 Your Solana ring is active — {len(members)} wallet(s)",
            "url": f"{EXPL}/token/{mint}",
            "color": 0xFF9F0A,
            "fields": [
                {"name": "What they touched",
                 "value": f"[{label or 'token'}]({EXPL}/token/{mint})\n`{mint[:20]}…`"},
                {"name": "Ring composition",
                 "value": f"**{len(members)}** active · {len(recur)} recurring"},
                {"name": "Ring score", "value": f"{score}/100 (recurrence-weighted)"},
                {"name": "Wallets", "value": body or "—"},
            ],
            "footer": {"text": "FnF sol ring monitor — mint-driven, no launch watching"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }],
    }
    log(f"SOL RING ALERT {mint[:12]} members={len(members)} score={score} {extra}")
    send_discord(embed)

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "add":
        mint = sys.argv[2]
        label = sys.argv[3] if len(sys.argv) > 3 else None
        res, err = add_mint(mint, label)
        if err:
            log(f"add failed: {err}")
        else:
            log(f"added {res['mint']}: this cohort={res['ring_size']} wallets, "
                f"ring now={res['total_ring_wallets']} wallets, score={res['score']}/100")
    elif cmd == "list":
        s = load_store()
        log(f"ring: {len(s['wallets'])} wallets across {len(s['mints'])} mints")
        for w, r in sorted(s["wallets"].items(), key=lambda kv: -kv[1]["buys"])[:10]:
            log(f"  {w[:14]}… buys={r['buys']} in {r['appearances']} mint(s)")
    elif cmd == "score":
        s = load_store()
        log(f"ring score = {score_ring(s)}/100  ({len(s['wallets'])} wallets)")
    elif cmd == "monitor":
        monitor()
    else:
        log("usage: add <mint> [label] | list | score | monitor")

if __name__ == "__main__":
    main()
