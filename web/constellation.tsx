/**
 * "The Room" — a live force-directed map of what the comments are arguing
 * about. Each topic is a body of mass: bigger with more distinct voices, hotter
 * (red) as the comments mentioning it turn angry, cooler (green) when they turn
 * warm. Topics raised together in the same comment are tethered, so the shape
 * of the argument emerges — which grievances travel as a pair.
 *
 * Drawn to canvas rather than SVG: the glow, the tethers and the pulse are all
 * per-frame work, and canvas keeps it smooth while the feed streams underneath.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { scaleLinear, scaleSqrt } from "d3-scale";
import { interpolateRgb } from "d3-interpolate";
import type { TopicGraph } from "../src/graph";

interface Node extends SimulationNodeDatum {
  id: string;
  label: string;
  voices: number;
  mentions: number;
  sentiment: number | null;
  weak: boolean;
  /** Timestamp of the last mention increase — drives the pulse ring. */
  pulseAt: number;
  /** Eased radius so a growing topic swells rather than snapping. */
  shown: number;
}

type Link = SimulationLinkDatum<Node> & { weight: number };

/** Heat scale: angry red → neutral amber → warm green. */
const heat = scaleLinear<string>()
  .domain([-2.5, 0, 2.5])
  .range(["#ef4444", "#f59e0b", "#22c55e"])
  .interpolate(interpolateRgb)
  .clamp(true);

/**
 * Size tracks how much a topic is dominating — its accumulated, decayed weight —
 * so a subject the room keeps hammering visibly outgrows a passing mention.
 * Sqrt keeps area (not radius) proportional to the number, which is what the eye
 * actually compares.
 */
const radius = scaleSqrt().domain([1, 40]).range([12, 64]).clamp(true);

/** How big a topic should be drawn: its heat, with voices as a floor. */
const massOf = (n: { mentions: number; voices: number }) => Math.max(n.mentions, n.voices);

const PULSE_MS = 1100;

export function Constellation({ graph, filter, onToggle }: {
  graph: TopicGraph;
  filter: string | null;
  onToggle: (topic: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef(new Map<string, Node>());
  const linksRef = useRef<Link[]>([]);
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const hoverRef = useRef<string | null>(null);
  const filterRef = useRef<string | null>(filter);
  filterRef.current = filter;

  const [hasData, setHasData] = useState(false);
  // Re-run the data effect only when the graph's shape/values actually change.
  const shape = useMemo(
    () =>
      graph.nodes.map((n) => `${n.id}:${n.voices}:${n.mentions}:${n.sentiment ?? ""}`).join("|") +
      "//" +
      graph.links.map((l) => `${l.source}-${l.target}:${l.weight}`).join("|"),
    [graph],
  );

  // ---- feed the simulation, preserving positions across updates ----
  useEffect(() => {
    const now = performance.now();
    const map = nodesRef.current;
    const incoming = new Set(graph.nodes.map((n) => n.id));

    for (const n of graph.nodes) {
      const existing = map.get(n.id);
      if (existing) {
        if (n.mentions > existing.mentions) existing.pulseAt = now;
        Object.assign(existing, { ...n, pulseAt: existing.pulseAt, shown: existing.shown });
      } else {
        // New topics drop in from a ring around the centre so they fly inward.
        const angle = (map.size * 137.5 * Math.PI) / 180; // golden angle, avoids clumping
        const { w, h } = sizeRef.current;
        map.set(n.id, {
          ...n,
          x: w / 2 + Math.cos(angle) * (w / 3.2),
          y: h / 2 + Math.sin(angle) * (h / 3.2),
          pulseAt: now,
          shown: 0,
        });
      }
    }
    for (const id of [...map.keys()]) if (!incoming.has(id)) map.delete(id);

    const nodes = [...map.values()];
    linksRef.current = graph.links
      .filter((l) => map.has(l.source) && map.has(l.target))
      .map((l) => ({ source: map.get(l.source)!, target: map.get(l.target)!, weight: l.weight }));

    setHasData(nodes.length > 0);

    const sim = simRef.current;
    if (sim) {
      sim.nodes(nodes);
      (sim.force("link") as ReturnType<typeof forceLink<Node, Link>>).links(linksRef.current);
      sim.alpha(0.7); // gentle reheat; the rAF loop drives ticks, so no restart()
    }
  }, [shape]);

  // ---- simulation + render loop ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    /**
     * Bodies shrink on a small canvas. Without this a phone-width map keeps
     * desktop-sized nodes, and the repulsion flings half of them past the edges
     * where they simply can't be read.
     */
    const sizeFactor = () => {
      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) return 1;
      return Math.max(0.52, Math.min(1, Math.min(w, h) / 420));
    };
    const nodeRadius = (n: Node) => radius(massOf(n)) * sizeFactor();

    const sim = forceSimulation<Node, Link>([])
      .force("link", forceLink<Node, Link>([]).id((d) => d.id).distance((l) => (150 - Math.min(70, l.weight * 16)) * sizeFactor()).strength((l) => Math.min(0.9, 0.25 + l.weight * 0.12)))
      .force("charge", forceManyBody<Node>().strength((d) => (-170 - nodeRadius(d) * 9) * sizeFactor()))
      .force("collide", forceCollide<Node>().radius((d) => nodeRadius(d) + 14 * sizeFactor()).strength(0.9))
      .force("x", forceX<Node>().strength(0.045))
      .force("y", forceY<Node>().strength(0.06))
      .stop();
    simRef.current = sim;

    // The data effect runs before this one on mount, so adopt whatever it staged.
    const seeded = [...nodesRef.current.values()];
    if (seeded.length > 0) {
      sim.nodes(seeded);
      (sim.force("link") as ReturnType<typeof forceLink<Node, Link>>).links(linksRef.current);
      sim.alpha(0.9);
    }

    const styles = getComputedStyle(document.documentElement);
    const readVar = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    let ink = readVar("--ink", "#e7ecf3");
    let faint = readVar("--ink-faint", "#8b95a4");
    let accent = readVar("--accent", "#7d9cff");

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { w: rect.width, h: rect.height };
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sim.force("center", forceCenter(rect.width / 2, rect.height / 2));
      sim.force("x", forceX<Node>(rect.width / 2).strength(0.045));
      sim.force("y", forceY<Node>(rect.height / 2).strength(0.06));
      sim.alpha(0.5);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => {
      const s = getComputedStyle(document.documentElement);
      ink = s.getPropertyValue("--ink").trim() || ink;
      faint = s.getPropertyValue("--ink-faint").trim() || faint;
      accent = s.getPropertyValue("--accent").trim() || accent;
    };
    themeQuery.addEventListener("change", onTheme);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) return;

      if (sim.alpha() > sim.alphaMin()) sim.tick();
      ctx.clearRect(0, 0, w, h);

      const nodes = [...nodesRef.current.values()];

      // Keep every body — and its label, which is centred on the node and is
      // often wider than the circle — inside the canvas. Clamping to the radius
      // alone still left names like "pull factors" clipped at a phone width.
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue;
        const r = nodeRadius(n) + 4;
        ctx.font = labelFont(n, r);
        const halfLabel = ctx.measureText(labelOf(n, w)).width / 2 + 4;
        const padX = Math.min(Math.max(r, halfLabel), w / 2);
        n.x = Math.min(Math.max(n.x, padX), Math.max(padX, w - padX));
        n.y = Math.min(Math.max(n.y, r), Math.max(r, h - r - 16));
      }
      const active = filterRef.current?.toLowerCase() ?? null;
      const hover = hoverRef.current;

      // --- tethers: topics said in the same breath, with the traffic between them ---
      for (const l of linksRef.current) {
        const a = l.source as Node;
        const b = l.target as Node;
        if (a.x == null || b.x == null || a.y == null || b.y == null) continue;
        const lit =
          hover === a.id || hover === b.id ||
          (active !== null && (a.id.toLowerCase() === active || b.id.toLowerCase() === active));

        // Bow each tether so crossing pairs stay legible instead of overlapping.
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const cx = mx + (-dy / len) * len * 0.12;
        const cy = my + (dx / len) * len * 0.12;

        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        grad.addColorStop(0, tint(a, 1));
        grad.addColorStop(1, tint(b, 1));
        ctx.strokeStyle = grad;
        ctx.globalAlpha = lit ? 0.9 : Math.min(0.42, 0.12 + l.weight * 0.05);
        ctx.lineWidth = Math.min(6, 0.9 + l.weight * 0.8);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cx, cy, b.x, b.y);
        ctx.stroke();

        // Motes drifting along the tether — one per co-mention, so a heavily
        // shared pair visibly courses with traffic.
        const motes = Math.min(4, l.weight);
        for (let i = 0; i < motes; i++) {
          const phase = ((now * 0.00016 + i / motes + len * 0.0007) % 1 + 1) % 1;
          const t = phase;
          const it = 1 - t;
          const px = it * it * a.x + 2 * it * t * cx + t * t * b.x;
          const py = it * it * a.y + 2 * it * t * cy + t * t * b.y;
          ctx.globalAlpha = (lit ? 0.95 : 0.5) * Math.sin(t * Math.PI); // fade in/out at the ends
          ctx.fillStyle = tint(t < 0.5 ? a : b, 1);
          ctx.beginPath();
          ctx.arc(px, py, lit ? 2.6 : 1.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // --- bodies ---
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue;
        const target = nodeRadius(n);
        n.shown += (target - n.shown) * 0.12; // ease toward the new size
        const r = n.shown;
        const colour = tint(n, 1);
        const isActive = active !== null && n.id.toLowerCase() === active;
        const dim = active !== null && !isActive ? 0.32 : 1;

        // pulse ring on a fresh mention
        const age = now - n.pulseAt;
        if (age < PULSE_MS) {
          const p = age / PULSE_MS;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + p * 34, 0, Math.PI * 2);
          ctx.strokeStyle = colour;
          ctx.globalAlpha = (1 - p) * 0.5 * dim;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // glow
        const glow = ctx.createRadialGradient(n.x, n.y, r * 0.2, n.x, n.y, r * 2.5);
        glow.addColorStop(0, tint(n, 0.5));
        glow.addColorStop(1, tint(n, 0));
        ctx.globalAlpha = (n.weak ? 0.3 : 0.75) * dim;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 2.5, 0, Math.PI * 2);
        ctx.fill();

        // core
        ctx.globalAlpha = (n.weak ? 0.45 : 1) * dim;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = tint(n, n.weak ? 0.35 : 0.9);
        ctx.fill();
        ctx.lineWidth = isActive ? 3 : hover === n.id ? 2.5 : 1.5;
        ctx.strokeStyle = isActive ? accent : colour;
        ctx.stroke();

        // label
        ctx.globalAlpha = dim;
        ctx.font = labelFont(n, r);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = n.weak ? faint : ink;
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = 6;
        ctx.fillText(labelOf(n, w), n.x, n.y);
        ctx.shadowBlur = 0;

        // voices, tucked under the label
        ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
        ctx.fillStyle = faint;
        ctx.fillText(`${n.voices} ${n.voices === 1 ? "voice" : "voices"}`, n.x, n.y + r + 11);
        ctx.globalAlpha = 1;
      }

      // --- heat legend, so the colour means something without a caption ---
      if (nodes.length > 0) {
        const lx = 14;
        const ly = h - 20;
        const lw = 104;
        const bar = ctx.createLinearGradient(lx, 0, lx + lw, 0);
        bar.addColorStop(0, heat(-2.5));
        bar.addColorStop(0.5, heat(0));
        bar.addColorStop(1, heat(2.5));
        ctx.fillStyle = bar;
        ctx.globalAlpha = 0.85;
        roundRect(ctx, lx, ly, lw, 5, 2.5);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.font = "600 9px ui-sans-serif, system-ui, sans-serif";
        ctx.fillStyle = faint;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText("angry", lx, ly - 5);
        ctx.textAlign = "right";
        ctx.fillText("warm", lx + lw, ly - 5);
      }
    };
    raf = requestAnimationFrame(draw);

    // --- interaction ---
    const pick = (ev: PointerEvent): Node | null => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      for (const n of nodesRef.current.values()) {
        if (n.x == null || n.y == null) continue;
        if (Math.hypot(n.x - x, n.y - y) <= n.shown + 4) return n;
      }
      return null;
    };
    const onMove = (ev: PointerEvent) => {
      const hit = pick(ev);
      hoverRef.current = hit?.id ?? null;
      canvas.style.cursor = hit ? "pointer" : "default";
    };
    const onClick = (ev: PointerEvent) => {
      const hit = pick(ev);
      if (hit) onToggle(hit.id);
    };
    const onLeave = () => {
      hoverRef.current = null;
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onClick);
    canvas.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeQuery.removeEventListener("change", onTheme);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onClick);
      canvas.removeEventListener("pointerleave", onLeave);
      sim.stop();
      simRef.current = null;
    };
    // onToggle is stable (useCallback in App); the loop reads live data via refs.
  }, [onToggle]);

  return (
    <div className="room" ref={wrapRef}>
      <canvas ref={canvasRef} className="room__canvas" />
      {!hasData && <p className="room__empty">Listening for topics to argue about…</p>}
    </div>
  );
}

/** The font a node's label is drawn in — shared by measuring and rendering. */
function labelFont(n: Node, r: number): string {
  return `${n.weak ? 500 : 650} ${Math.max(11, Math.min(15, r * 0.42))}px ui-sans-serif, system-ui, sans-serif`;
}

/**
 * A node's label, shortened when the canvas is too narrow to hold it. Long
 * topics ("stop the boats", "pull factors") otherwise run past both edges on a
 * phone no matter where the body itself is clamped.
 */
function labelOf(n: Node, canvasWidth: number): string {
  const max = canvasWidth < 380 ? 13 : canvasWidth < 520 ? 18 : 28;
  return n.label.length > max ? `${n.label.slice(0, max - 1).trimEnd()}…` : n.label;
}

/** Rounded rect that works without relying on the newer ctx.roundRect. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Node colour at a given alpha — hot when the room is angry about it. */
function tint(n: Node, alpha: number): string {
  const base = n.sentiment === null ? "#94a3b8" : heat(n.sentiment);
  if (alpha >= 1) return base;
  const [r, g, b] = rgb(base);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function rgb(hex: string): [number, number, number] {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (m) return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  const n = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(hex);
  if (n) return [Number(n[1]), Number(n[2]), Number(n[3])];
  return [148, 163, 184];
}
