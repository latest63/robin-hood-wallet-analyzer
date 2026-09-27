import { useEffect, useRef, useState } from 'react';

// Compact per-cluster radar widget (Concept A).
// - Rings + rotating sweep + blips on a single canvas, DPR-scaled.
// - Blip angle = wallet's slot around the dial, distance = |profit| (log),
//   size = |profit| normalized to the cluster.
// - Color language: solid orange = positive PnL, hollow amber = negative PnL.
// - Sweep passing a blip fires a short expanding ripple (continuous motion).
// - Hover a blip -> tooltip with short address + profit.
// - prefers-reduced-motion: static render (rings + blips, no sweep/ripples).
const ORANGE = '#f97316';
const AMBER = '#fb923c';

export default function ClusterRadar({ wallets, size = 112 }) {
  const canvasRef = useRef(null);
  const blipsRef = useRef([]);
  const hoverRef = useRef(null);
  const [hover, setHover] = useState(null);

  // Recompute blip layout whenever the wallet set changes.
  useEffect(() => {
    const list = (wallets || []).slice(0, 48);
    const maxProfit = list.reduce((m, w) => Math.max(m, Math.abs(Number(w.profit) || 0)), 0);
    const norm = p => (maxProfit > 0 ? Math.log10(1 + Math.abs(p)) / Math.log10(1 + maxProfit) : 0);
    blipsRef.current = list.map((w, i) => {
      const profit = Number(w.profit) || 0;
      const angle = (i / Math.max(list.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return {
        angle,
        dist: 0.35 + 0.55 * norm(profit),
        r: 1.6 + 2.6 * norm(profit),
        positive: (Number(w.pnl_pct) || 0) >= 0,
        label: `${String(w.wallet_address || '').slice(0, 8)}...${String(w.wallet_address || '').slice(-6)} · $${profit.toLocaleString()}`
      };
    });
  }, [wallets]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const cx = size / 2, cy = size / 2, R = size / 2 - 4;
    const ripples = [];
    let raf = 0;

    const reduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const blipPos = b => [cx + Math.cos(b.angle) * R * b.dist, cy + Math.sin(b.angle) * R * b.dist];

    const drawStatic = () => {
      ctx.clearRect(0, 0, size, size);
      ctx.lineWidth = 1;
      [0.35, 0.6, 0.85].forEach(f => {
        ctx.strokeStyle = 'rgba(249,115,22,0.10)';
        ctx.beginPath();
        ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.fillStyle = 'rgba(249,115,22,0.55)';
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawBlips = now => {
      for (const b of blipsRef.current) {
        const [x, y] = blipPos(b);
        const isHover = hoverRef.current === b;
        ctx.beginPath();
        if (b.positive) {
          ctx.fillStyle = ORANGE;
          ctx.globalAlpha = isHover ? 1 : 0.85;
          ctx.arc(x, y, b.r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = AMBER;
          ctx.globalAlpha = isHover ? 1 : 0.8;
          ctx.lineWidth = 1.4;
          ctx.arc(x, y, b.r, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (isHover) {
          ctx.strokeStyle = 'rgba(249,115,22,0.9)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, b.r + 3.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        for (let i = ripples.length - 1; i >= 0; i--) {
          const rp = ripples[i];
          if (rp.blip !== b) continue;
          const age = now - rp.t0;
          if (age > 700) { ripples.splice(i, 1); continue; }
          const p = age / 700;
          ctx.strokeStyle = `rgba(249,115,22,${(1 - p) * 0.5})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 2 + p * 10, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    };

    const drawSweep = angle => {
      const trail = 1.2;
      for (let i = 14; i >= 1; i--) {
        const a = angle - (i / 14) * trail;
        ctx.strokeStyle = `rgba(249,115,22,${0.05 * (1 - i / 14)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(249,115,22,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * R, cy + Math.sin(angle) * R);
      ctx.stroke();
    };

    let lastAngle = -Math.PI / 2;
    let lastT = performance.now();

    const frame = now => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      lastAngle += dt * 1.1; // rad/s sweep
      // Sweep-crossing detection -> fire a ripple (one per blip while its ripple lives)
      const TAU = Math.PI * 2;
      const aa = ((lastAngle % TAU) + TAU) % TAU;
      const la = ((((lastAngle - dt * 1.1) % TAU) + TAU) % TAU);
      for (const b of blipsRef.current) {
        const ba = ((b.angle % TAU) + TAU) % TAU;
        const crossed = la <= aa
          ? ba > la && ba <= aa
          : ba > la || ba <= aa;
        if (crossed && !ripples.some(rp => rp.blip === b)) {
          ripples.push({ blip: b, t0: now });
        }
      }
      drawStatic();
      drawSweep(lastAngle);
      drawBlips(now);
    };

    if (reduced) {
      drawStatic();
      drawBlips(performance.now());
    } else {
      raf = requestAnimationFrame(frame);
    }

    const onMove = e => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let best = null, bestD = 9;
      for (const b of blipsRef.current) {
        const [x, y] = blipPos(b);
        const d = Math.hypot(mx - x, my - y);
        if (d < bestD) { bestD = d; best = b; }
      }
      if (best !== hoverRef.current) {
        hoverRef.current = best;
        if (best) {
          const [x, y] = blipPos(best);
          setHover({ label: best.label, x, y });
        } else {
          setHover(null);
        }
      }
    };
    const onLeave = () => {
      hoverRef.current = null;
      setHover(null);
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, [size]);

  const tracked = (wallets || []).length;

  return (
    <div className="cluster-radar">
      <div className="radar-canvas-wrap">
        <canvas ref={canvasRef} style={{ width: size, height: size }} />
        {hover && (
          <div
            className="radar-tooltip"
            style={{
              left: Math.max(56, Math.min(hover.x, size - 56)),
              top: Math.max(2, hover.y - 10)
            }}
          >
            {hover.label}
          </div>
        )}
      </div>
      <div className="radar-caption">{tracked} tracked</div>
    </div>
  );
}
