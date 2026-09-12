#!/usr/bin/env python3
"""
SNIPE-style evaluation engine
Based on https://github.com/0xwhrari/SNIPE

Implements:
- Burst scoring (wallets entering within time windows)
- Evaluation rules (LOCK/TRACK/DROP verdicts)
- Paper trading with TP/SL/trailing
"""

from dataclasses import dataclass, field
from typing import Optional
import time

@dataclass
class Token:
    """Token data structure matching SNIPE model"""
    symbol: str
    name: str
    address: str
    discovered_at: float  # Unix timestamp
    age_sec: int = 0
    market_cap: float = 0
    liquidity: float = 0
    volume_5m: float = 0
    
    # Burst metrics
    burst_10s: int = 0      # Top wallets in first 10s
    burst_30s: int = 0      # Top wallets in first 30s
    smart_wallets: int = 0  # Tracked profitable wallets
    wallet_quality: int = 0  # 0-100
    wallet_clusters: int = 0
    
    # Flow metrics
    net_flow_eth: float = 0  # Net ETH bought/sold
    
    # Quality metrics
    ai_score: int = 0       # AI opportunity score
    gmgn_audit: int = 0     # Audit score (0-100)
    fomo_heat: int = 0      # 0-100
    fomo_top_buys: int = 0  # Top trader buys
    
    # Concentration
    top10_pct: float = 0.0  # Top 10 holder concentration
    
    # Risk
    contract_risk: str = "LOW"  # LOW, MED, HIGH
    deployer_flagged: bool = False
    
    # Price data
    price: float = 0.0
    move_5m: float = 0.0  # % change
    
    # Provider source
    source: str = "RH"    # RH, PONS, DIRECT
    
    # PonsPad specific
    bonding_pct: int = 0  # Curve progress 0-100
    pons_reserve_eth: float = 0
    pons_graduation_eth: float = 4.2
    pons_snipe_tax: int = 0


@dataclass
class Wallet:
    """Tracked wallet"""
    handle: str
    hit_rate: float = 0.0
    pnl_30d: float = 0.0
    cluster: str = "A1"
    rh_launch_hits: int = 0
    avg_entry_sec: float = 0.0
    source_rank: str = "TOP"


@dataclass
class Position:
    """Paper trading position"""
    id: str
    symbol: str
    address: str
    size_eth: float
    entry_price: float
    mark_price: float
    pnl_pct: float = 0.0
    peak_pct: float = 0.0
    opened_at: float = 0.0
    status: str = "OPEN"  # OPEN, CLOSED


@dataclass
class EvalResult:
    """Evaluation result"""
    verdict: str  # LOCK, TRACK, DROP
    checks: list = field(default_factory=list)
    reason: str = ""
    failed: list = field(default_factory=list)
    burst_score: int = 0


class SnipeRules:
    """Evaluation rules matching SNIPE"""
    
    def __init__(self):
        self.min_ai = 70
        self.min_burst_10s = 3
        self.min_smart_wallets = 3
        self.min_wallet_quality = 72
        self.min_net_flow_eth = 0.25
        self.min_gmgn_audit = 68
        self.min_liquidity = 9000
        self.max_top10 = 35
        self.max_fresh = 68
        self.blocked_risk = ["HIGH"]
        self.require_deployer_not_flagged = True
        
        # Paper trading
        self.paper_size_eth = 0.10
        self.max_open = 4
        self.session_budget_eth = 0.60
        self.take_profit_pct = 70
        self.stop_loss_pct = -24
        self.trail_pct = 18
        self.max_hold_min = 24
    
    def burst_score(self, token: Token) -> int:
        """Calculate burst score 0-100"""
        burst = min(100, token.burst_10s * 15 + token.burst_30s * 4)
        wallets = min(100, token.wallet_quality)
        flow = min(100, max(0, token.net_flow_eth * 45))
        fomo = min(100, token.fomo_heat)
        clusters = min(100, token.wallet_clusters * 24)
        
        return round(burst * 0.34 + wallets * 0.24 + flow * 0.16 + fomo * 0.12 + clusters * 0.14)
    
    def evaluate(self, token: Token) -> EvalResult:
        """Evaluate token against rules"""
        checks = [
            {"key": "BURST10", "ok": token.burst_10s >= self.min_burst_10s, 
             "value": f"{token.burst_10s}/{self.min_burst_10s}", 
             "why": "top-wallet entries inside 10s"},
            {"key": "TOPW", "ok": token.smart_wallets >= self.min_smart_wallets,
             "value": f"{token.smart_wallets}/{self.min_smart_wallets}",
             "why": "tracked profitable wallets"},
            {"key": "WALLETQ", "ok": token.wallet_quality >= self.min_wallet_quality,
             "value": f"{token.wallet_quality}/{self.min_wallet_quality}",
             "why": "wallet quality"},
            {"key": "FLOW", "ok": token.net_flow_eth >= self.min_net_flow_eth,
             "value": f"{token.net_flow_eth:.2f}/{self.min_net_flow_eth:.2f}E",
             "why": "net early buy flow"},
            {"key": "AUDIT", "ok": token.gmgn_audit >= self.min_gmgn_audit,
             "value": f"{token.gmgn_audit}/{self.min_gmgn_audit}",
             "why": "GMGN-style audit score"},
            {"key": "AI", "ok": token.ai_score >= self.min_ai,
             "value": f"{token.ai_score}/{self.min_ai}",
             "why": "AI opportunity score"},
            {"key": "LIQ", "ok": token.liquidity >= self.min_liquidity,
             "value": f"${token.liquidity//1000}K/${self.min_liquidity//1000}K",
             "why": "minimum executable depth"},
            {"key": "TOP10", "ok": token.top10_pct < self.max_top10,
             "value": f"{token.top10_pct:.1f}%/<{self.max_top10}%",
             "why": "holder concentration"},
            {"key": "RISK", "ok": self.blocked_risk not in [token.contract_risk],
             "value": token.contract_risk,
             "why": "contract risk"},
            {"key": "DEPLOY", "ok": not self.require_deployer_not_flagged or not token.deployer_flagged,
             "value": "FLAGGED" if token.deployer_flagged else "OK",
             "why": "deployer history"},
        ]
        
        failed = [c for c in checks if not c["ok"]]
        
        # Hard fails
        hard = any(
            c["key"] in ["RISK", "DEPLOY"] or
            (c["key"] == "TOP10" and token.top10_pct >= 42) or
            token.gmgn_audit < 40 or
            token.ai_score < 50
            for c in failed
        )
        
        if not failed:
            verdict = "LOCK"
            reason = "wallet burst + audit + liquidity aligned"
        elif hard:
            verdict = "DROP"
            reason = f"{failed[0]['key']} hard-failed"
        else:
            verdict = "TRACK"
            reason = f"{failed[0]['key']} needs confirmation"
        
        return EvalResult(
            verdict=verdict,
            checks=checks,
            reason=reason,
            failed=failed,
            burst_score=self.burst_score(token)
        )
    
    def thesis(self, token: Token, decision: EvalResult) -> str:
        """Generate natural language thesis"""
        burst = f"{token.burst_10s} top-wallet entries / 10s, {token.wallet_clusters} independent clusters, {token.net_flow_eth:.2f} ETH net flow"
        providers = f"GMGN audit {token.gmgn_audit}, fomo heat {token.fomo_heat}, {'Pons curve ' + str(token.bonding) + '%' if token.source == 'PONS' else 'direct pool'}"
        
        if decision.verdict == "LOCK":
            return f"Target lock: {burst}. {providers}. Wallet quality {token.wallet_quality}/100 with top-10 concentration {token.top10_pct}%. This is the exact pattern SNIPE is hunting."
        elif decision.verdict == "DROP":
            return f"Drop target: {decision.reason}. {burst}. {providers}. The early-wallet pattern is not enough to offset the hard risk or audit failure."
        else:
            return f"Track target: {decision.reason}. {burst}. {providers}. Keep the contract in scope until another quality wallet cluster arrives."


class SnipeRuntime:
    """Main runtime class managing tokens, wallets, and positions"""
    
    def __init__(self, demo: bool = False):
        self.demo = demo
        self.tokens: dict[str, Token] = {}
        self.wallets: list[Wallet] = []
        self.rules = SnipeRules()
        self.positions: list[Position] = []
        self.closed: list[Position] = []
        self.events: list[dict] = []
        self.session_spent_eth: float = 0.0
        self.started_at: float = time.time()
        self.block: int = 53976000  # Current approx block
        
        # Load sample wallets
        self._load_sample_wallets()
    
    def _load_sample_wallets(self):
        """Load sample tracked wallets"""
        self.wallets = [
            Wallet("early_bird", hit_rate=0.65, pnl_30d=12500, cluster="A1", rh_launch_hits=47),
            Wallet("sniper_king", hit_rate=0.58, pnl_30d=8900, cluster="A1", rh_launch_hits=38),
            Wallet("rh_whale", hit_rate=0.52, pnl_30d=6700, cluster="A2", rh_launch_hits=29),
            Wallet("meme_master", hit_rate=0.48, pnl_30d=5400, cluster="B1", rh_launch_hits=22),
            Wallet("degod_hunter", hit_rate=0.45, pnl_30d=4200, cluster="B1", rh_launch_hits=18),
        ]
    
    def add_token(self, token: Token) -> Token:
        """Add or update a token"""
        addr = token.address.lower()
        if addr in self.tokens:
            existing = self.tokens[addr]
            # Update existing
            for k, v in vars(token).items():
                if v is not None:
                    setattr(existing, k, v)
            return existing
        
        self.tokens[addr] = token
        self._push_event("NEW", token, f"New launch detected · {token.source}")
        return token
    
    def scan_token(self, address: str) -> Optional[EvalResult]:
        """Scan a token and return evaluation"""
        addr = address.lower()
        token = self.tokens.get(addr)
        if not token:
            return None
        
        decision = self.rules.evaluate(token)
        self._push_event(decision.verdict, token, f"{decision.reason}")
        return decision
    
    def paper_open(self, token: Token, size_eth: float = None) -> dict:
        """Open a paper position"""
        size_eth = size_eth or self.rules.paper_size_eth
        
        if len(self.positions) >= self.rules.max_open:
            return {"ok": False, "message": "Max open positions reached"}
        
        if self.session_spent_eth + size_eth > self.rules.session_budget_eth:
            return {"ok": False, "message": "Session budget exceeded"}
        
        if any(p.symbol == token.symbol for p in self.positions):
            return {"ok": False, "message": f"${token.symbol} already open"}
        
        pos = Position(
            id=f"p{int(time.time()*1000)}",
            symbol=token.symbol,
            address=token.address,
            size_eth=size_eth,
            entry_price=token.price,
            mark_price=token.price,
            opened_at=time.time()
        )
        
        self.positions.append(pos)
        self.session_spent_eth += size_eth
        self._push_event("SNIPE", token, f"PAPER OPEN {size_eth:.3f} ETH @ ${token.price:.6f}")
        
        return {"ok": True, "position": pos, "message": f"Paper snipe opened ${token.symbol}"}
    
    def close_position(self, pos_id: str, reason: str = "MANUAL") -> bool:
        """Close a position"""
        for i, pos in enumerate(self.positions):
            if pos.id == pos_id:
                closed = self.positions.pop(i)
                closed.status = "CLOSED"
                closed.closed_at = time.time()
                closed.exit_reason = reason
                self.closed.insert(0, closed)
                self.session_spent_eth -= pos.size_eth
                self._push_event("EXIT", None, f"{reason} · {pos.pnl_pct:+.2f}%")
                return True
        return False
    
    def tick(self):
        """Advance simulation by one tick"""
        self.block += 1
        
        for token in self.tokens.values():
            # Simulate price movement
            drift = (len([w for w in self.wallets if w.hit_rate > 0.5]) * 0.02) - 0.01
            token.move_5m += (drift + (len(self.wallets) * 0.05))
            token.move_5m = max(-50, min(500, token.move_5m))
            
            # Update PnL for open positions
            for pos in self.positions:
                if pos.symbol == token.symbol:
                    pos.mark_price = token.price * (1 + token.move_5m / 100)
                    pos.pnl_pct = (pos.mark_price / pos.entry_price - 1) * 100
                    pos.peak_pct = max(pos.peak_pct or 0, pos.pnl_pct)
                    
                    # Check exit conditions
                    if pos.pnl_pct >= self.rules.take_profit_pct:
                        self.close_position(pos.id, "TP")
                    elif pos.pnl_pct <= self.rules.stop_loss_pct:
                        self.close_position(pos.id, "SL")
    
    def _push_event(self, event_type: str, token: Optional[Token], message: str):
        """Add event to history"""
        self.events.insert(0, {
            "id": f"e{int(time.time()*1000)}{hash(message) % 10000}",
            "at": time.time(),
            "type": event_type,
            "token_symbol": token.symbol if token else None,
            "message": message
        })
        # Keep last 100 events
        if len(self.events) > 100:
            self.events = self.events[:100]
    
    def get_recent_events(self, limit: int = 20) -> list:
        """Get recent events"""
        return self.events[:limit]
    
    def print_scan(self, address: str):
        """Print detailed scan for a token"""
        token = self.tokens.get(address.lower())
        if not token:
            print(f"Unknown token: {address}")
            return
        
        decision = self.rules.evaluate(token)
        
        print(f"\n${token.symbol} · {token.name}")
        print(f"Address: {token.address}")
        print(f"Verdict: {decision.verdict} · AI {token.ai_score}/100 · Burst {decision.burst_score}")
        print()
        
        for check in decision.checks:
            icon = "✓" if check["ok"] else "✗"
            print(f"  {icon} {check['key']}: {check['value']} - {check['why']}")
        
        print()
        print(f"MCap: ${token.market_cap:,.0f} · Liq: ${token.liquidity:,.0f} · Vol5m: ${token.volume_5m:,.0f}")
        print(f"Burst: 10s={token.burst_10s} 30s={token.burst_30s} · Flow: {token.net_flow_eth:.2f}ETH")
        print(f"Wallets: {token.smart_wallets} tracked · Quality: {token.wallet_quality}%")
        print(f"GMGN: audit {token.gmgn_audit} rank #{token.gmgn_audit + 10}")
        print(f"FOMO: heat {token.fomo_heat} · top buys {token.fomo_top_buys}")
        
        if token.source == "PONS":
            print(f"Pons: curve {token.bonding}% · reserve {token.pons_reserve_eth:.2f}/{token.pons_graduation_eth:.1f}ETH")
        
        print()
        print(f"AI Thesis: {self.rules.thesis(token, decision)}")


def create_sample_tokens():
    """Create sample tokens for testing"""
    tokens = [
        Token(
            symbol="AMC",
            name="A Meme Coin",
            address="0x385f4f8ae47651ce5f58f5265395a669f8281e18",
            discovered_at=time.time() - 3600,
            age_sec=3600,
            burst_10s=5,
            burst_30s=8,
            smart_wallets=4,
            wallet_quality=85,
            wallet_clusters=2,
            net_flow_eth=1.2,
            ai_score=82,
            gmgn_audit=78,
            fomo_heat=65,
            liquidity=25000,
            top10_pct=18.5,
            contract_risk="LOW",
            price=0.000042,
            move_5m=15.3,
            source="RH"
        ),
        Token(
            symbol="FROG",
            name="Frog Launch",
            address="0x1234567890abcdef1234567890abcdef12345678",
            discovered_at=time.time() - 1200,
            age_sec=1200,
            burst_10s=2,
            burst_30s=3,
            smart_wallets=2,
            wallet_quality=65,
            net_flow_eth=0.3,
            ai_score=55,
            gmgn_audit=62,
            liquidity=12000,
            top10_pct=28.0,
            contract_risk="MED",
            price=0.000018,
            move_5m=5.2,
            source="PONS",
            bonding_pct=45,
            pons_reserve_eth=1.89
        ),
        Token(
            symbol="SCAM",
            name="Scam Token",
            address="0xabcdef1234567890abcdef1234567890abcdef12",
            discovered_at=time.time() - 600,
            age_sec=600,
            burst_10s=1,
            smart_wallets=1,
            wallet_quality=45,
            net_flow_eth=-0.5,
            ai_score=32,
            gmgn_audit=45,
            liquidity=5000,
            top10_pct=45.0,
            contract_risk="HIGH",
            deployer_flagged=True,
            price=0.000001,
            move_5m=-12.5,
            source="RH"
        )
    ]
    return tokens


if __name__ == "__main__":
    import sys
    
    rt = SnipeRuntime(demo=False)
    
    # Add sample tokens
    for t in create_sample_tokens():
        rt.add_token(t)
    
    if len(sys.argv) > 1:
        query = sys.argv[1]
        if query.startswith("0x"):
            rt.print_scan(query)
        else:
            # Search by symbol
            for addr, token in rt.tokens.items():
                if token.symbol.upper() == query.upper():
                    rt.print_scan(addr)
                    break
    else:
        # Show all evaluations
        print("=" * 60)
        print("SNIPE-RH · Wallet Burst Scanner")
        print("=" * 60)
        
        for addr, token in rt.tokens.items():
            decision = rt.rules.evaluate(token)
            print(f"\n${token.symbol} ({token.name})")
            print(f"  Verdict: {decision.verdict} | Burst: {decision.burst_score}/100")
            print(f"  Address: {addr}")
            print(f"  Checks:")
            for c in decision.checks:
                icon = "✓" if c["ok"] else "✗"
                print(f"    {icon} {c['key']}: {c['value']}")
        
        print("\n" + "=" * 60)
        print("Events Log:")
        for ev in rt.get_recent_events(10):
            ts = time.strftime("%H:%M:%S", time.localtime(ev["at"]))
            print(f"  [{ts}] {ev['type']:7} {ev['message']}")
