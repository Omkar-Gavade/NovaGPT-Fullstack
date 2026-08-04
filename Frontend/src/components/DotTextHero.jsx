import { useEffect, useRef } from "react";

/**
 * Interactive dotted "NovaGPT" wordmark — the one element preserved from the
 * original site. Particles form the text and scatter away from the cursor,
 * easing back to rest. Sized to its own container (with DPR) and initialised
 * after fonts load, so it renders reliably; the rAF loop is cancelled on
 * unmount to avoid StrictMode double-loop leaks.
 */
export default function DotTextHero({ isDark }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    let particles = [];
    let raf = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const mouse = { x: -9999, y: -9999, active: false };

    const DRAG = 0.86;
    const EASE = 0.14;
    const RADIUS_INFLUENCE = 34; // px in CSS space

    function build() {
      const parent = canvas.parentElement;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (!w || !h) return;

      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const spacing = w < 768 ? 5 : 4;

      const tCanvas = document.createElement("canvas");
      tCanvas.width = w;
      tCanvas.height = h;
      const tctx = tCanvas.getContext("2d");

      const fontSize = Math.min(w * 0.22, h * 0.78);
      tctx.fillStyle = "#000";
      tctx.textAlign = "center";
      tctx.textBaseline = "middle";
      tctx.font = `800 ${fontSize}px "Geist Variable", system-ui, sans-serif`;
      tctx.fillText("NovaGPT", w / 2, h / 2);

      const data = tctx.getImageData(0, 0, w, h).data;
      particles = [];
      for (let y = 0; y < h; y += spacing) {
        for (let x = 0; x < w; x += spacing) {
          if (data[(x + y * w) * 4 + 3] > 128) {
            particles.push({ x, y, ox: x, oy: y, vx: 0, vy: 0 });
          }
        }
      }
    }

    function frame() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const dot = isDark ? "rgba(232,232,238,0.92)" : "rgba(40,40,48,0.85)";
      const radius = isDark ? 1.5 : 1.2;
      ctx.fillStyle = dot;

      for (const p of particles) {
        if (mouse.active) {
          const dx = p.x - mouse.x;
          const dy = p.y - mouse.y;
          const dist = Math.hypot(dx, dy);
          if (dist < RADIUS_INFLUENCE * 3 && dist > 0.01) {
            const force = (RADIUS_INFLUENCE / dist) ** 2;
            p.vx += (dx / dist) * force;
            p.vy += (dy / dist) * force;
          }
        }
        p.vx *= DRAG;
        p.vy *= DRAG;
        p.x += p.vx + (p.ox - p.x) * EASE;
        p.y += p.vy + (p.oy - p.y) * EASE;

        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    }

    function onMove(e) {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
      mouse.active = true;
    }
    function onLeave() {
      mouse.active = false;
    }

    let started = false;
    function start() {
      if (started) return;
      started = true;
      build();
      frame();
    }

    // init once fonts are ready (fallback to a timeout)
    if (document.fonts?.ready) {
      document.fonts.ready.then(start);
    }
    const fallback = setTimeout(start, 300);

    const ro = new ResizeObserver(() => build());
    ro.observe(canvas.parentElement);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fallback);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [isDark]);

  return <canvas ref={canvasRef} className="dot-hero-canvas" aria-hidden="true" />;
}
