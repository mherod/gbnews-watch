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
  /** Broadcasts this topic was argued under, strongest first (see TopicNode). */
  onAir?: { title: string; share: number }[];
  /** Timestamp of the last mention increase — drives the pulse ring. */
  pulseAt: number;
  /** Eased radius so a growing topic swells rather than snapping. */
  shown: number;
  /** Per-node phase so bodies don't drift in lockstep. */
  drift: number;
  /** Drawn position (simulation position + idle drift) — hit-testing uses this. */
  px: number;
  py: number;
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
      graph.nodes.map((n) => `${n.id}:${n.voices}:${n.mentions}:${n.sentiment ?? ""}:${n.onAir?.[0]?.title ?? ""}`).join("|") +
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
          // Phase derived from the label, so a topic drifts the same way every
          // session and two bodies never bob in unison.
          drift: [...n.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 628 / 100,
          px: w / 2,
          py: h / 2,
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
      .force("link", forceLink<Node, Link>([]).id((d) => d.id).distance((l) => (165 - Math.min(60, l.weight * 16)) * sizeFactor()).strength((l) => Math.min(0.9, 0.3 + l.weight * 0.12)))
      .force("charge", forceManyBody<Node>().strength((d) => (-240 - nodeRadius(d) * 12) * sizeFactor()))
      .force("collide", forceCollide<Node>().radius((d) => nodeRadius(d) + 22 * sizeFactor()).strength(1.0))
      .force("x", forceX<Node>().strength(0.05))
      .force("y", forceY<Node>().strength(0.065))
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
    let panel = readVar("--panel", "#161b22");
    let line = readVar("--line", "#262d38");
    // Labels are stroked in the page background so they stay readable wherever
    // they land — over a glow, a tether, or another body's halo.
    let halo = readVar("--bg", "#0e1116");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
      panel = s.getPropertyValue("--panel").trim() || panel;
      line = s.getPropertyValue("--line").trim() || line;
      halo = s.getPropertyValue("--bg").trim() || halo;
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

      // Who the hovered body is tethered to — computed once per frame so the
      // focus dimming below doesn't rescan every link for every node.
      let neighbourCache: Set<string> | null = null;
      const neighbours = (id: string): Set<string> => {
        if (neighbourCache) return neighbourCache;
        const set = new Set<string>([id]);
        for (const l of linksRef.current) {
          const a = (l.source as Node).id;
          const b = (l.target as Node).id;
          if (a === id) set.add(b);
          else if (b === id) set.add(a);
        }
        return (neighbourCache = set);
      };

      // The legend's footprint. Bodies are kept out of it so the scale is never
      // buried under a node, as it was under "Mike Parry".
      const legend = { x: 12, y: h - 40, w: 122, h: 28 };

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

        if (n.x - r < legend.x + legend.w && n.y + r > legend.y) {
          n.y = Math.max(r, legend.y - r - 6);
        }

        // A slow, tiny orbit so the map breathes instead of sitting frozen
        // between simulation ticks. Purely visual — the physics never sees it.
        const wobble = reduceMotion ? 0 : 2.4;
        n.px = n.x + Math.sin(now * 0.00042 + n.drift) * wobble;
        n.py = n.y + Math.cos(now * 0.00037 + n.drift * 1.7) * wobble;
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
        // Hovering a body pushes everything it isn't tied to into the background,
        // so one topic's connections can actually be read out of the tangle.
        const muted = hover !== null && !lit;

        // Bow each tether so crossing pairs stay legible instead of overlapping.
        const mx = (a.px + b.px) / 2;
        const my = (a.py + b.py) / 2;
        const dx = b.px - a.px;
        const dy = b.py - a.py;
        const len = Math.hypot(dx, dy) || 1;
        const cx = mx + (-dy / len) * len * 0.12;
        const cy = my + (dx / len) * len * 0.12;

        const grad = ctx.createLinearGradient(a.px, a.py, b.px, b.py);
        grad.addColorStop(0, tint(a, 1));
        grad.addColorStop(1, tint(b, 1));
        ctx.strokeStyle = grad;
        // Floor raised from 0.12: the tethers are the whole point of the map and
        // were nearly invisible at low weights.
        ctx.globalAlpha = muted ? 0.07 : lit ? 0.95 : Math.min(0.6, 0.28 + l.weight * 0.06);
        ctx.lineWidth = Math.min(6, 1.2 + l.weight * 0.8);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a.px, a.py);
        ctx.quadraticCurveTo(cx, cy, b.px, b.py);
        ctx.stroke();

        // Motes drifting along the tether — one per co-mention, so a heavily
        // shared pair visibly courses with traffic.
        const motes = Math.min(4, l.weight);
        for (let i = 0; i < motes; i++) {
          const t = ((now * 0.00016 + i / motes + len * 0.0007) % 1 + 1) % 1;
          const it = 1 - t;
          const mxp = it * it * a.px + 2 * it * t * cx + t * t * b.px;
          const myp = it * it * a.py + 2 * it * t * cy + t * t * b.py;
          ctx.globalAlpha = (muted ? 0.12 : lit ? 0.95 : 0.6) * Math.sin(t * Math.PI);
          ctx.fillStyle = tint(t < 0.5 ? a : b, 1);
          ctx.beginPath();
          ctx.arc(mxp, myp, lit ? 2.6 : 1.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // --- bodies ---
      // Biggest first so small bodies land on top and never hide behind a giant.
      for (const n of [...nodes].sort((p, q) => q.shown - p.shown)) {
        if (n.x == null || n.y == null) continue;
        const target = nodeRadius(n);
        n.shown += (target - n.shown) * 0.12; // ease toward the new size
        const r = n.shown;
        if (r < 0.5) continue;
        const colour = tint(n, 1);
        const isActive = active !== null && n.id.toLowerCase() === active;
        const isHovered = hover === n.id;
        const linkedToHover = hover !== null && (isHovered || neighbours(hover).has(n.id));
        const dim =
          (active !== null && !isActive ? 0.32 : 1) * (hover !== null && !linkedToHover ? 0.35 : 1);

        // pulse ring on a fresh mention
        const age = now - n.pulseAt;
        if (age < PULSE_MS) {
          const p = age / PULSE_MS;
          ctx.beginPath();
          ctx.arc(n.px, n.py, r + p * 34, 0, Math.PI * 2);
          ctx.strokeStyle = colour;
          ctx.globalAlpha = (1 - p) * 0.5 * dim;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Glow, kept tight on faded topics — a wide halo on every body turned
        // the middle of the map into an indistinct smear.
        const glowR = r * (n.weak ? 1.7 : 2.4);
        const glow = ctx.createRadialGradient(n.px, n.py, r * 0.2, n.px, n.py, glowR);
        glow.addColorStop(0, tint(n, n.weak ? 0.3 : 0.55));
        glow.addColorStop(1, tint(n, 0));
        ctx.globalAlpha = (n.weak ? 0.22 : 0.7) * dim;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(n.px, n.py, glowR, 0, Math.PI * 2);
        ctx.fill();

        // Core enamel disc
        ctx.globalAlpha = (n.weak ? 0.6 : 1) * dim;
        const body = ctx.createRadialGradient(
          n.px - r * 0.3, n.py - r * 0.35, r * 0.05,
          n.px, n.py, r,
        );
        body.addColorStop(0, tint(n, n.weak ? 0.6 : 1));
        body.addColorStop(0.85, tint(n, n.weak ? 0.3 : 0.85));
        body.addColorStop(1, tint(n, n.weak ? 0.2 : 0.7));
        ctx.beginPath();
        ctx.arc(n.px, n.py, r, 0, Math.PI * 2);
        ctx.fillStyle = body;
        ctx.fill();
        ctx.lineWidth = isActive ? 3.5 : isHovered ? 2.5 : 2;
        ctx.strokeStyle = isActive ? accent : colour;
        ctx.stroke();

        // Label: inside the body only when it genuinely fits, otherwise beneath it with a backing pill.
        ctx.globalAlpha = dim;
        ctx.font = labelFont(n, r);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const text = labelOf(n, w);
        const textMetrics = ctx.measureText(text);
        const textW = textMetrics.width;
        const inside = textW <= r * 1.55;
        const ty = inside ? n.py : n.py + r + 13;

        if (!inside) {
          // Draw solid enamel pill behind outside label for guaranteed legibility over tethers
          ctx.fillStyle = panel;
          ctx.globalAlpha = 0.92 * dim;
          roundRect(ctx, n.px - textW / 2 - 6, ty - 8, textW + 12, 16, 4);
          ctx.fill();
          ctx.strokeStyle = line;
          ctx.lineWidth = 1;
          roundRect(ctx, n.px - textW / 2 - 6, ty - 8, textW + 12, 16, 4);
          ctx.stroke();
          ctx.globalAlpha = dim;
        }

        ctx.fillStyle = inside && !n.weak ? "#ffffff" : ink;
        ctx.fillText(text, n.px, ty);

        // voices count tucked neatly under
        ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
        ctx.fillStyle = faint;
        const vy = inside ? n.py + r + 12 : ty + 15;
        const voices = `${n.voices} ${n.voices === 1 ? "voice" : "voices"}`;
        ctx.fillText(voices, n.px, vy);

        // On hover, which broadcast the argument belongs to
        const during = n.onAir?.[0];
        if (isHovered && during) {
          const max = canvasWidthChars(w);
          const title = during.title.length > max ? `${during.title.slice(0, max - 1).trimEnd()}…` : during.title;
          const line = `during ${title} · ${Math.round(during.share * 100)}%`;
          const cy = vy + 18 > h ? Math.max(12, n.py - r - 14) : vy + 14;
          const lineMetrics = ctx.measureText(line);
          ctx.fillStyle = panel;
          ctx.globalAlpha = 0.95;
          roundRect(ctx, n.px - lineMetrics.width / 2 - 6, cy - 8, lineMetrics.width + 12, 16, 4);
          ctx.fill();
          ctx.strokeStyle = line;
          ctx.lineWidth = 1;
          roundRect(ctx, n.px - lineMetrics.width / 2 - 6, cy - 8, lineMetrics.width + 12, 16, 4);
          ctx.stroke();
          ctx.fillStyle = ink;
          ctx.fillText(line, n.px, cy);
        }
        ctx.globalAlpha = 1;
      }

      // --- heat legend, so the colour means something without a caption ---
      if (nodes.length > 0) {
        const lx = 14;
        const ly = h - 20;
        const lw = 104;

        // Seat the scale on its own panel so it stays readable over whatever
        // the simulation drifts behind it.
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = panel;
        roundRect(ctx, legend.x, legend.y, legend.w, legend.h, 8);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = line;
        ctx.lineWidth = 1;
        roundRect(ctx, legend.x, legend.y, legend.w, legend.h, 8);
        ctx.stroke();

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
        ctx.fillText("Fuming", lx, ly - 5);
        ctx.textAlign = "right";
        ctx.fillText("Chuffed", lx + lw, ly - 5);
      }
    };
    raf = requestAnimationFrame(draw);

    // --- interaction ---
    const pick = (ev: PointerEvent): Node | null => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      for (const n of nodesRef.current.values()) {
        // Match the drawn position, not the simulation's — otherwise the drift
        // puts the clickable area slightly off the visible body.
        if (Math.hypot(n.px - x, n.py - y) <= n.shown + 4) return n;
      }
      return null;
    };
    const onMove = (ev: PointerEvent) => {
      const hit = pick(ev);
      hoverRef.current = hit ? hit.id : null;
      canvas.style.cursor = hit ? "pointer" : "default";
    };
    const onClick = (ev: PointerEvent) => {
      const hit = pick(ev);
      // Filter by the display label, not the case-folded id, so the banner
      // reads "Stop" rather than "stop".
      if (hit) onToggle(hit.label);
    };
    const onLeave = () => {
      hoverRef.current = null;
    };
    canvas.addEventListener("pointermove", onMove, { passive: true });
    canvas.addEventListener("pointerdown", onClick);
    canvas.addEventListener("pointerleave", onLeave, { passive: true });

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

  const topNode = useMemo(() => {
    if (graph.nodes.length === 0) return null;
    return [...graph.nodes].sort((a, b) => (b.voices || b.mentions) - (a.voices || a.mentions))[0];
  }, [graph.nodes]);

  const canvasLabel = graph.nodes.length === 0
    ? "The Taproom: listening for topics being debated across the realm"
    : `${graph.nodes.length} topic${graph.nodes.length === 1 ? "" : "s"} being debated${topNode ? `; strongest: ${topNode.label}` : ""}`;

  return (
    <div className="room" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="room__canvas"
        role="img"
        aria-label={canvasLabel}
      />
      <ul className="room__topics-list" aria-label="Room topics">
        {graph.nodes.map((node) => {
          const active = filter?.toLowerCase() === node.label.toLowerCase();
          return (
            <li key={node.id}>
              <button
                type="button"
                className="room__topic-btn"
                onClick={() => onToggle(node.label)}
                aria-pressed={active}
                aria-label={node.weak ? `${node.label}, 1 voice` : `${node.label}, ${node.voices} ${node.voices === 1 ? "voice" : "voices"}`}
              >
                {node.label}
              </button>
            </li>
          );
        })}
      </ul>
      {!hasData && <p className="room__empty">Listening for topics being debated in the room…</p>}
    </div>
  );
}

/** The font a node's label is drawn in — shared by measuring and rendering. */
function labelFont(n: Node, r: number): string {
  return `${n.weak ? 500 : 650} ${Math.max(11, Math.min(15, r * 0.42))}px ui-sans-serif, system-ui, sans-serif`;
}

/** How many characters a caption can afford at this canvas width. */
function canvasWidthChars(canvasWidth: number): number {
  return canvasWidth < 380 ? 13 : canvasWidth < 520 ? 18 : 28;
}

/**
 * A node's label, shortened when the canvas is too narrow to hold it. Long
 * topics ("stop the boats", "pull factors") otherwise run past both edges on a
 * phone no matter where the body itself is clamped.
 */
function labelOf(n: Node, canvasWidth: number): string {
  const max = canvasWidthChars(canvasWidth);
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
