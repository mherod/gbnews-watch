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

/** Heat scale: Central-line red (fuming) → slate → District green (chuffed). */
const heat = scaleLinear<string>()
  .domain([-1.6, 0, 1.6])
  .range(["#C8102E", "#94A3B8", "#00782A"])
  .interpolate(interpolateRgb)
  .clamp(true);

/**
 * The board is a fixed dark stage in both themes — it never reads the page's
 * theme variables, so its own mini-palette lives here.
 */
const CANVAS_FONT = '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif';
const BOARD_INK = "#F8FAFC";
const BOARD_PILL = "rgba(10, 23, 51, 0.92)";

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

export function Constellation({ graph, filter, onToggle, hostRe = null }: {
  graph: TopicGraph;
  filter: string | null;
  onToggle: (topic: string) => void;
  /** Matches the on-air presenter — their node is the landlord of the board. */
  hostRe?: RegExp | null;
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
  const hostReRef = useRef<RegExp | null>(hostRe);
  hostReRef.current = hostRe;

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

    /**
     * How tangled the board currently looks, 0 (airy) → 1 (hairball). Driven by
     * how many label pills are sitting on top of each other, which is the thing
     * that actually makes a busy night unreadable.
     */
    let tangle = 0;

    /**
     * How far a tether has been let out at the current tangle: 0 taut, 1 slack.
     * The flimsiest links give first — a pair argued over once shouldn't hold a
     * topic inside the crowd — while anything argued over four times or more
     * keeps its full pull, so real associations never come apart.
     */
    const slackOf = (weight: number, t: number) => t * Math.max(0, 1 - (weight - 1) / 3);

    const linkDistance = (l: Link) => (165 - Math.min(60, l.weight * 16)) * sizeFactor() * (1 + 0.7 * tangle);
    const linkStrength = (l: Link) =>
      Math.min(0.9, 0.3 + l.weight * 0.12) * (1 - slackOf(l.weight, tangle));
    const chargeStrength = (d: Node) => (-240 - nodeRadius(d) * 12) * sizeFactor() * (1 + 1.1 * tangle);

    const sim = forceSimulation<Node, Link>([])
      .force("link", forceLink<Node, Link>([]).id((d) => d.id).distance(linkDistance).strength(linkStrength))
      .force("charge", forceManyBody<Node>().strength(chargeStrength))
      .force("collide", forceCollide<Node>().radius((d) => {
        const sf = sizeFactor();
        // The label pill below each disc is usually wider than the disc; give
        // the physics an approximate half-pill so neighbouring labels stop
        // stacking. ~6.2px per character at the pill's font, plus the count.
        const pillHalf = ((`${d.label} · ${d.voices}`.length + 2) * 6.2 * Math.max(sf, 0.8)) / 2;
        return Math.max(nodeRadius(d) + 22 * sf, pillHalf);
      }).strength(1.0))
      .force("x", forceX<Node>().strength(0.05))
      .force("y", forceY<Node>().strength(0.065))
      .stop();
    simRef.current = sim;

    /**
     * Push the current tangle into the forces. d3 reads these accessors when a
     * force initialises, not every tick, so the setters are re-invoked to make
     * a new reading take. Called only when the tangle has actually moved.
     */
    const applyTangle = () => {
      const link = sim.force("link") as ReturnType<typeof forceLink<Node, Link>>;
      link.distance(linkDistance).strength(linkStrength);
      (sim.force("charge") as ReturnType<typeof forceManyBody<Node>>).strength(chargeStrength);
      // The centring pull is what packs a busy board into one lump; easing it
      // off is what lets a released cluster drift away and become its own branch.
      const { w, h } = sizeRef.current;
      const ease = 1 - 0.8 * tangle;
      sim.force("x", forceX<Node>(w / 2).strength(0.045 * ease));
      sim.force("y", forceY<Node>(h / 2).strength(0.06 * ease));
    };

    // The data effect runs before this one on mount, so adopt whatever it staged.
    const seeded = [...nodesRef.current.values()];
    if (seeded.length > 0) {
      sim.nodes(seeded);
      (sim.force("link") as ReturnType<typeof forceLink<Node, Link>>).links(linksRef.current);
      sim.alpha(0.9);
    }

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
      applyTangle(); // owns the x/y pull, so the relaxation survives a resize
      sim.alpha(0.5);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

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

      // Keep every body — and its label, which is centred on the node and is
      // often wider than the circle — inside the canvas. Clamping to the radius
      // alone still left names like "pull factors" clipped at a phone width.
      // The extra bottom margin clears the label pill drawn below each disc.
      const pills: { x: number; y: number; hw: number }[] = [];
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue;
        const r = nodeRadius(n) + 4;
        ctx.font = labelFont(n, r);
        // Pill extends half the text plus 7px padding; wobble adds ~1.2px.
        const halfLabel = ctx.measureText(labelOf(n, w)).width / 2 + 9;
        pills.push({ x: n.x, y: n.y + r + 13, hw: halfLabel });
        const padX = Math.min(Math.max(r, halfLabel), w / 2);
        n.x = Math.min(Math.max(n.x, padX), Math.max(padX, w - padX));
        n.y = Math.min(Math.max(n.y, r), Math.max(r, h - r - 30));

        // Keep label pills clear of the HTML legend's bottom-left footprint
        // (gradient swatch + "Fuming → Chuffed" runs ~205px wide).
        if (n.x - halfLabel < 215 && n.y + r + 21.5 > h - 29) {
          n.y = Math.max(r, h - 29 - 21.5 - r);
        }

        // A slow, tiny orbit so the map breathes instead of sitting frozen
        // between simulation ticks. Purely visual — the physics never sees it.
        const wobble = reduceMotion ? 0 : 1.2;
        n.px = n.x + Math.sin(now * 0.00042 + n.drift) * wobble;
        n.py = n.y + Math.cos(now * 0.00037 + n.drift * 1.7) * wobble;
      }
      // --- How tangled is it? Count the bodies whose labels are sitting on top
      // of another one; that share is the tangle the forces respond to. ---
      const crowded = new Set<number>();
      for (let i = 0; i < pills.length; i++) {
        for (let j = i + 1; j < pills.length; j++) {
          const p = pills[i]!;
          const q = pills[j]!;
          if (Math.abs(p.x - q.x) < p.hw + q.hw && Math.abs(p.y - q.y) < 17) {
            crowded.add(i);
            crowded.add(j);
          }
        }
      }
      const target = pills.length > 0 ? crowded.size / pills.length : 0;
      // Asymmetric easing, and the slow side matters: relaxing *removes* the
      // overlaps that asked for it, so a symmetric return would re-tighten, tangle
      // again, and leave the board breathing in and out. Loosen over a second or
      // so, take the better part of a minute to draw back in.
      const prev = tangle;
      tangle += (target - tangle) * (target > tangle ? 0.04 : 0.004);
      if (Math.abs(tangle - prev) > 0.002) {
        applyTangle();
        if (sim.alpha() < 0.06) sim.alpha(0.12); // enough heat to actually move
      }

      const active = filterRef.current?.toLowerCase() ?? null;
      const hover = hoverRef.current;

      // --- Tethers: quiet chalk lines that light Central-line red when lit ---
      for (let idx = 0; idx < linksRef.current.length; idx++) {
        const l = linksRef.current[idx]!;
        const a = l.source as Node;
        const b = l.target as Node;
        if (a.x == null || b.x == null || a.y == null || b.y == null) continue;
        const lit =
          hover === a.id || hover === b.id ||
          (active !== null && (a.id.toLowerCase() === active || b.id.toLowerCase() === active));
        const muted = hover !== null && !lit;

        // Tube track line
        const mx = (a.px + b.px) / 2;
        const my = (a.py + b.py) / 2;
        const dx = b.px - a.px;
        const dy = b.py - a.py;
        const len = Math.hypot(dx, dy) || 1;
        const cx = mx + (-dy / len) * len * 0.08;
        const cy = my + (dx / len) * len * 0.08;

        // A tether the physics has let go of shouldn't still look like it's
        // holding the board together — it fades as it goes slack.
        const slack = slackOf(l.weight, tangle);
        ctx.strokeStyle = lit ? "#C8102E" : "rgba(255, 255, 255, 0.16)";
        ctx.globalAlpha = (muted ? 0.06 : lit ? 0.9 : 1) * (1 - 0.75 * slack);
        ctx.lineWidth = lit ? 3 : Math.min(3, 1.2 + l.weight * 0.5);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a.px, a.py);
        ctx.quadraticCurveTo(cx, cy, b.px, b.py);
        ctx.stroke();

        // One lone train, only on the tether you point at — the drier gag.
        if (lit) {
          const t = ((now * 0.00018 + len * 0.0008) % 1 + 1) % 1;
          const it = 1 - t;
          const mxp = it * it * a.px + 2 * it * t * cx + t * t * b.px;
          const myp = it * it * a.py + 2 * it * t * cy + t * t * b.py;
          ctx.globalAlpha = 0.9 * Math.sin(t * Math.PI);
          ctx.fillStyle = "#FFFFFF";
          ctx.beginPath();
          ctx.arc(mxp, myp, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // --- London Station Interchange Discs ---
      for (const n of [...nodes].sort((p, q) => q.shown - p.shown)) {
        if (n.x == null || n.y == null) continue;
        const target = nodeRadius(n);
        n.shown += (target - n.shown) * 0.12;
        const r = n.shown;
        if (r < 0.5) continue;
        const colour = tint(n, 1);
        const isActive = active !== null && n.id.toLowerCase() === active;
        const isHovered = hover === n.id;
        const linkedToHover = hover !== null && (isHovered || neighbours(hover).has(n.id));
        const dim =
          (active !== null && !isActive ? 0.35 : 1) * (hover !== null && !linkedToHover ? 0.35 : 1);

        // Pulse ring on fresh debate mention — a ripple, not a fire alarm.
        const age = now - n.pulseAt;
        if (age < PULSE_MS) {
          const p = age / PULSE_MS;
          ctx.beginPath();
          ctx.arc(n.px, n.py, r + p * 14, 0, Math.PI * 2);
          ctx.strokeStyle = "#C8102E";
          ctx.globalAlpha = (1 - p) * 0.35 * dim;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Solid heat-tinted disc with a thin white ring — the roundel
        // silhouette with legible temperature. The on-air presenter's node
        // wears a gilt ring: the landlord of tonight's argument.
        const isHost = hostReRef.current?.test(n.label) ?? false;
        ctx.globalAlpha = (n.weak ? 0.65 : 1) * dim;
        ctx.beginPath();
        ctx.arc(n.px, n.py, r, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.fill();
        ctx.lineWidth = isActive ? 3 : isHost ? 2.5 : 2;
        ctx.strokeStyle =
          isActive || isHovered ? "#C8102E" : isHost ? "#F2B33D" : `rgba(255, 255, 255, ${n.weak ? 0.4 : 0.85})`;
        ctx.stroke();

        // Station-name pill below the disc, count folded in.
        ctx.globalAlpha = dim;
        ctx.font = labelFont(n, r);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const text = labelOf(n, w);
        const textW = ctx.measureText(text).width;
        const ty = n.py + r + 13;

        ctx.fillStyle = BOARD_PILL;
        ctx.globalAlpha = 0.92 * dim;
        roundRect(ctx, n.px - textW / 2 - 7, ty - 8, textW + 14, 17, 4);
        ctx.fill();
        ctx.strokeStyle = isActive ? "#C8102E" : isHost ? "rgba(242, 179, 61, 0.5)" : "rgba(255, 255, 255, 0.18)";
        ctx.lineWidth = 1;
        roundRect(ctx, n.px - textW / 2 - 7, ty - 8, textW + 14, 17, 4);
        ctx.stroke();
        ctx.globalAlpha = dim;

        ctx.fillStyle = BOARD_INK;
        ctx.fillText(text, n.px, ty);

        // Hover tooltip — a news-channel lower third, white on navy.
        const during = n.onAir?.[0];
        if (isHovered && during) {
          const max = canvasWidthChars(w);
          const title = during.title.length > max ? `${during.title.slice(0, max - 1).trimEnd()}…` : during.title;
          const line = `As heard on: ${title} (${Math.round(during.share * 100)}%)`;
          const cy = ty + 26 > h ? Math.max(12, n.py - r - 14) : ty + 22;
          ctx.font = `600 11px ${CANVAS_FONT}`;
          const lineMetrics = ctx.measureText(line);
          ctx.fillStyle = "#012169";
          ctx.globalAlpha = 0.96;
          roundRect(ctx, n.px - lineMetrics.width / 2 - 8, cy - 9, lineMetrics.width + 16, 18, 5);
          ctx.fill();
          ctx.strokeStyle = "#C8102E";
          ctx.lineWidth = 1.5;
          roundRect(ctx, n.px - lineMetrics.width / 2 - 8, cy - 9, lineMetrics.width + 16, 18, 5);
          ctx.stroke();
          ctx.fillStyle = "#FFFFFF";
          ctx.fillText(line, n.px, cy);
        }
        ctx.globalAlpha = 1;
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
      <div className="room__legend" aria-hidden="true">
        <i />
        Fuming → Chuffed
      </div>
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
  return `${n.weak ? 500 : 600} ${Math.max(11, Math.min(15, r * 0.42))}px ${CANVAS_FONT}`;
}

/** How many characters a caption can afford at this canvas width. */
function canvasWidthChars(canvasWidth: number): number {
  return canvasWidth < 380 ? 13 : canvasWidth < 520 ? 18 : 28;
}

/**
 * A node's label pill text: the topic (shortened when the canvas is too narrow
 * to hold it — long topics like "stop the boats" otherwise run past both edges
 * on a phone) with the voice count folded in after an interpunct.
 */
function labelOf(n: Node, canvasWidth: number): string {
  const max = canvasWidthChars(canvasWidth);
  const label = n.label.length > max ? `${n.label.slice(0, max - 1).trimEnd()}…` : n.label;
  return `${label} · ${n.voices}`;
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
