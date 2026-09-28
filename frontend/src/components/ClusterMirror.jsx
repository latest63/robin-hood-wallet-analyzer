import { useEffect, useRef, useState } from 'react';

// Cluster Mirror — a living constellation that mirrors the cluster:
// the shared token sits at the core, every cluster wallet orbits it. When a
// tracked wallet re-buys the token, that satellite IGNITES (flare + expanding
// ring), fires a beam to the core, and the core beats — the visual "show it"
// when a re-buy event happens. A live ticker below lists the recent re-buys.
//
// - Mobile-first: the canvas fills its card (width:100%, capped on desktop,
//   aspect-ratio:1) so it never forces horizontal overflow on phones.
// - Continuous ambient motion: orbiting wallets + a soft rotating sweep.
// - prefers-reduced-motion: static render (no orbit; flares still draw once).
// - Caps ~24 orbiting wallets for legibility; extra wallets stay in the table.

const ORANGE = '#f97316';

function fmtAmount(raw, decimals) {
  try {
    let val = raw;
    if (typeof val !== 'string' || val === '0x' || val === '') val = '0';
    const v = Number(BigInt(val) / 10n ** BigInt(decimals || 18));
    if (!Number.isFinite(v)) return '0';
    return v >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
      : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K'
      : v.toFixed(v >= 100 ? 0 : 2);
  } catch (e) {
    return '0';
  }
}

export default function ClusterMirror({ wallets, events, symbol = 'TOKEN' }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const orbitsRef = useRef([]);
  const flaresRef = useRef([]);       // { orbit, t0 }
  const seenKeyRef = useRef(new Set());
  const beatRef = useRef(null);       // { t0 } when a beam reaches the core
  const hoverRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [lastSeen, setLastSeen] = useState(null);

  // Build a stable orbit layout from the wallet set (golden-angle spacing so
  // repeated polls never re-scatter the constellation).
  useEffect(() => {
    const list = (wallets || []).slice(0, 48);
    orbitsRef.current = list.map((w, i) => {
      const angle = i * 2.399963229728653;
      const orbit = 0.24 + 0.6 * Math.sqrt(i / Math.max(list.length - 1, 1));
      const speed = 0.14 + 0.22 * ((i % 5) / 4);
      return {
        wallet: String(w.wallet_address || ''),
        profit: Number(w.profit) || 0,
        angle0: angle,
        orbit,
        speed,
        dir: i % 2 === 0 ? 1 : -1,
      };
    });
  }, [wallets]);

  // Turn new re-buy events into flares + remember the most recent one.
  useEffect(() => {
    if (!events || events.length === 0) return;
    let newest = null;
    for (const ev of events) {
      const key = ev.txHash + ':' + ev.wallet;
      if (seenKeyRef.current.has(key)) continue;
      seenKeyRef.current.add(key);
      const o = orbitsRef.current.find(x => x.wallet === ev.wallet);
      if (o) flaresRef.current.push({ orbit: o, t0: performance.now() });
      if (!newest || (ev.block || 0) > (newest.block || 0)) newest = ev;
    }
    if (newest) {
      beatRef.current = { t0: performance.now() };
      setLastSeen(newest);
    }
    if (flaresRef.current.length > 24) flaresRef.current = flaresRef.current.slice(-24);
  }, [events]);

  // Canvas render loop — DPR-aware + ResizeObserver-driven (fills the card).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    const reduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let W = 300, H = 300, dpr = 1;
    const applySize = () => {
      const r = wrap.getBoundingClientRect();
      W = Math.max(180, Math.floor(r.width));
      H = W;
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(wrap);

    let raf = 0;
    let phase = 0;
    let lastT = performance.now();
    const R = () => W / 2 - 12;

    const orbitPos = (o, pAngle) => {
      const cx = W / 2, cy = H / 2;
      const a = o.angle0 + (reduced ? 0 : pAngle * o.speed * o.dir);
      return [cx + Math.cos(a) * R() * o.orbit, cy + Math.sin(a) * R() * o.orbit];
    };

    const drawStatic = () => {
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      ctx.lineWidth = 1;
      [0.3, 0.5, 0.7, 0.87].forEach(f => {
        ctx.strokeStyle = 'rgba(249,115,22,0.08)';
        ctx.beginPath();
        ctx.arc(cx, cy, R() * f, 0, Math.PI * 2);
        ctx.stroke();
      });
    };

    const drawCore = now => {
      const cx = W / 2, cy = H / 2;
      let beatScale = 1;
      if (beatRef.current) {
        const age = now - beatRef.current.t0;
        if (age < 900) beatScale = 1 + 0.5 * Math.sin((age / 900) * Math.PI);
        else beatRef.current = null;
      }
      const coreR = Math.max(10, R() * 0.12) * beatScale;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.6);
      g.addColorStop(0, 'rgba(249,115,22,0.55)');
      g.addColorStop(0.5, 'rgba(249,115,22,0.18)');
      g.addColorStop(1, 'rgba(249,115,22,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ORANGE;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(cx - coreR * 0.25, cy - coreR * 0.25, coreR * 0.5, 0, Math.PI * 2);
      ctx.fill();
      if (symbol) {
        ctx.font = `700 ${Math.max(9, coreR * 0.55)}px Orbitron, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(symbol).slice(0, 6), cx, cy + coreR + Math.max(10, coreR * 0.5));
      }
    };

    const drawSweep = pAngle => {
      if (reduced) return;
      const cx = W / 2, cy = H / 2;
      for (let i = 12; i >= 1; i--) {
        const a = pAngle - (i / 12) * 0.7;
        ctx.strokeStyle = `rgba(249,115,22,${0.04 * (1 - i / 12)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * R(), cy + Math.sin(a) * R());
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(249,115,22,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(pAngle) * R(), cy + Math.sin(pAngle) * R());
      ctx.stroke();
    };

    const drawWallets = (now, pAngle) => {
      const cx = W / 2, cy = H / 2;
      for (const o of orbitsRef.current) {
        const [x, y] = orbitPos(o, pAngle);
        ctx.strokeStyle = 'rgba(249,115,22,0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, R() * o.orbit, 0, Math.PI * 2);
        ctx.stroke();
        const isHover = hoverRef.current === o;
        const r = Math.max(2.2, R() * 0.028);
        ctx.beginPath();
        ctx.fillStyle = ORANGE;
        ctx.globalAlpha = isHover ? 1 : 0.9;
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (isHover) {
          ctx.strokeStyle = 'rgba(249,115,22,0.9)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        // flares for this orbit
        for (let i = flaresRef.current.length - 1; i >= 0; i--) {
          const f = flaresRef.current[i];
          if (f.orbit !== o) continue;
          const age = now - f.t0;
          if (age > 2600) { flaresRef.current.splice(i, 1); continue; }
          const p = age / 2600;
          const fr = r + p * (R() * 0.18);
          ctx.strokeStyle = `rgba(239,68,68,${(1 - p) * 0.9})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, fr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = `rgba(239,68,68,${(1 - p) * 0.8})`;
          ctx.beginPath();
          ctx.arc(x, y, r + p * 4, 0, Math.PI * 2);
          ctx.fill();
          if (p < 0.4) {
            const bp = p / 0.4;
            const bx = x + (cx - x) * bp;
            const by = y + (cy - y) * bp;
            const grad = ctx.createLinearGradient(x, y, bx, by);
            grad.addColorStop(0, `rgba(239,68,68,${(1 - bp) * 0.9})`);
            grad.addColorStop(1, 'rgba(239,68,68,0)');
            ctx.strokeStyle = grad;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
        }
      }
    };

    const frame = now => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      if (!reduced) phase += dt * 0.25;
      const pAngle = -Math.PI / 2 + phase;
      drawStatic();
      drawSweep(pAngle);
      drawCore(now);
      drawWallets(now, pAngle);
    };

    if (reduced) {
      const now = performance.now();
      const pAngle = -Math.PI / 2;
      drawStatic();
      drawCore(now);
      drawWallets(now, pAngle);
    } else {
      raf = requestAnimationFrame(frame);
    }

    const onMove = e => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let best = null, bestD = 10;
      const pAngle = -Math.PI / 2 + phase;
      for (const o of orbitsRef.current) {
        const [x, y] = orbitPos(o, pAngle);
        const d = Math.hypot(mx - x, my - y);
        if (d < bestD) { bestD = d; best = o; }
      }
      if (best !== hoverRef.current) {
        hoverRef.current = best;
        if (best) {
          const [x, y] = orbitPos(best, pAngle);
          const wrapW = wrap.clientWidth;
          setHover({
            label: `${best.wallet.slice(0, 8)}...${best.wallet.slice(-6)} · $${best.profit.toLocaleString()}`,
            x, y, w: wrapW
          });
        } else setHover(null);
      }
    };
    const onLeave = () => { hoverRef.current = null; setHover(null); };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, [symbol]);

  const tracked = (wallets || []).length;
  const recentEvents = (events || []).slice(0, 4);

  return (
    <div className="cluster-mirror">
      <div className="mirror-header">
        <span className="mirror-live-dot" aria-hidden="true" />
        <span className="mirror-live-text">LIVE</span>
        <span className="mirror-count">{tracked} wallets mirrored</span>
        {lastSeen && (
          <span className="mirror-lastseen">last signal +{fmtAmount(lastSeen.value, lastSeen.decimals)} · #{(lastSeen.block || 0).toLocaleString()}</span>
        )}
      </div>
      <div className="mirror-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} />
        {hover && (
          <div
            className="mirror-tooltip"
            style={{ left: Math.max(56, Math.min(hover.x, (hover.w || 300) - 56)), top: Math.max(2, hover.y - 12) }}
          >
            {hover.label}
          </div>
        )}
      </div>
      {recentEvents.length > 0 && (
        <div className="mirror-ticker">
          {recentEvents.map(ev => (
            <div key={ev.txHash + ev.wallet} className="mirror-tick">
              <span className="tick-pulse" aria-hidden="true" />
              <span className="tick-addr">{ev.wallet.slice(0, 6)}…{ev.wallet.slice(-4)}</span>
              <span className="tick-amt">+{fmtAmount(ev.value, ev.decimals)} {symbol}</span>
              <span className="tick-block">#{(ev.block || 0).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
