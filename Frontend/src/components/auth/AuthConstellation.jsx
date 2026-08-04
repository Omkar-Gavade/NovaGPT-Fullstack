import { useEffect, useRef } from "react";
import { MODELS } from "../../data/models";

/**
 * Signature backdrop for the auth "console": the 11 models as glowing nodes
 * drifting around a pulsing NovaGPT core, wired with faint edges and reactive to
 * the cursor (parallax). Communicates the multi-model identity at a glance.
 *
 * Lightweight canvas (11 nodes), DPR-capped, cancels its rAF on unmount, and
 * renders a single static frame when the user prefers reduced motion.
 */
const NODE_COLOR = {
  "gemini-2.5-flash": "#4285F4",
  "claude-sonnet": "#D97757",
  gpt: "#10A37F",
  deepseek: "#4D6BFE",
  kimi: "#7C6BF0",
  qwen: "#8B5CF6",
  llama: "#2F7BFF",
  mistral: "#FF7000",
  openrouter: "#6467F2",
  ollama: "#9AA0AA",
  "openai-compatible": "#7C8698",
};

export default function AuthConstellation({ isDark }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let t = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };

    const accent = isDark ? "#8b76ff" : "#6e56cf";
    const edge = isDark ? "rgba(255,255,255,0.16)" : "rgba(30,25,60,0.14)";
    const coreGlow = isDark ? "rgba(139,118,255,0.9)" : "rgba(110,86,207,0.85)";

    // node layout: three rings around the core
    const nodes = MODELS.map((m, i) => {
      const ring = i % 3; // 0,1,2
      const radius = 0.22 + ring * 0.15; // fraction of min dimension (orbits around the card)
      const angle = (i / MODELS.length) * Math.PI * 2 + ring * 0.5;
      return {
        m,
        color: NODE_COLOR[m.id] || accent,
        radius,
        angle,
        speed: 0.06 + (i % 4) * 0.02,
        wobble: 0.4 + (i % 3) * 0.25,
        r: 5 + (m.mono.length === 1 ? 1 : 0),
      };
    });

    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const minDim = Math.min(w, h);

      // ease pointer for smooth parallax
      pointer.x += (pointer.tx - pointer.x) * 0.06;
      pointer.y += (pointer.ty - pointer.y) * 0.06;
      const px = (pointer.x - 0.5) * minDim * 0.06;
      const py = (pointer.y - 0.5) * minDim * 0.06;

      const positions = nodes.map((n) => {
        const a = n.angle + t * n.speed;
        const wob = Math.sin(t * n.wobble + n.angle) * minDim * 0.012;
        const rad = n.radius * minDim + wob;
        return {
          n,
          x: cx + Math.cos(a) * rad + px * (0.5 + n.radius),
          y: cy + Math.sin(a) * rad + py * (0.5 + n.radius),
        };
      });

      // edges: core -> node
      ctx.lineWidth = 1;
      for (const p of positions) {
        ctx.strokeStyle = edge;
        ctx.beginPath();
        ctx.moveTo(cx + px * 0.3, cy + py * 0.3);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }

      // core glow + pulse
      const pulse = 0.5 + Math.sin(t * 1.4) * 0.5;
      const coreR = minDim * 0.028 + pulse * 4;
      const g = ctx.createRadialGradient(cx + px * 0.3, cy + py * 0.3, 0, cx + px * 0.3, cy + py * 0.3, coreR * 3.4);
      g.addColorStop(0, coreGlow);
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx + px * 0.3, cy + py * 0.3, coreR * 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(cx + px * 0.3, cy + py * 0.3, coreR, 0, Math.PI * 2);
      ctx.fill();

      // nodes
      for (const p of positions) {
        const { n } = p;
        // glow
        const ng = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, n.r * 5);
        ng.addColorStop(0, n.color + "cc");
        ng.addColorStop(1, "transparent");
        ctx.fillStyle = ng;
        ctx.beginPath();
        ctx.arc(p.x, p.y, n.r * 5, 0, Math.PI * 2);
        ctx.fill();
        // core dot
        ctx.fillStyle = n.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, n.r, 0, Math.PI * 2);
        ctx.fill();
        // monogram
        ctx.fillStyle = isDark ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.95)";
        ctx.font = `600 ${n.r + 2}px "Geist Variable", system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.m.mono, p.x, p.y + 0.5);
      }
    }

    function frame() {
      t += 0.006;
      draw();
      raf = requestAnimationFrame(frame);
    }

    function onMove(e) {
      const rect = canvas.getBoundingClientRect();
      pointer.tx = (e.clientX - rect.left) / rect.width;
      pointer.ty = (e.clientY - rect.top) / rect.height;
    }

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);

    if (reduce) {
      draw();
    } else {
      window.addEventListener("pointermove", onMove);
      frame();
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
    };
  }, [isDark]);

  return <canvas ref={canvasRef} className="auth-canvas" aria-hidden="true" />;
}
