"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ForceGraphEngine } from "./force-engine";
import { SmoothGraphViewport } from "./viewport";
import { collapseParallelEdges, layoutEdgeLabels } from "./edge-label-layout";
import { graphInputSignature } from "./graph-stability";
import {
  DEFAULT_GRAPH_TUNING,
  type GraphColorMap,
  type GraphEdgeInput,
  type GraphNodeInput,
  type GraphNodeState,
  type GraphTuning,
  type GraphTransform,
} from "./types";

export interface ForceGraphSvgProps<NodeMetadata = Record<string, unknown>, EdgeMetadata = Record<string, unknown>> {
  nodes: ReadonlyArray<GraphNodeInput<NodeMetadata>>;
  edges: ReadonlyArray<GraphEdgeInput<EdgeMetadata>>;
  width?: number;
  height?: number;
  tuning?: Partial<GraphTuning>;
  colors?: GraphColorMap;
  typeLabels?: Readonly<Record<string, string>>;
  selectedNodeId?: string | null;
  edgeLabelMode?: GraphEdgeLabelMode;
  resetToken?: number;
  initialAlpha?: number;
  /** Refit the camera when graph data changes after the first mount. */
  fitOnDataChange?: boolean;
  theme?: "light" | "dark";
  ariaLabel: string;
  className?: string | undefined;
  onNodeSelect?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onLayoutSnapshot?: (nodes: ReadonlyArray<GraphNodeState<NodeMetadata>>, camera: GraphTransform) => void;
  onLayoutFrame?: (nodes: ReadonlyArray<GraphNodeState<NodeMetadata>>) => void;
  onPerformanceSample?: (sample: GraphPerformanceSample) => void;
  /** Render a deterministic map snapshot instead of running a force simulation. */
  staticLayout?: boolean;
  /** Background regions used by the semantic-map presentation layer. */
  mapRegions?: ReadonlyArray<GraphMapRegion>;
}

export interface GraphMapRegion {
  id: string;
  label: string;
  kind: "area" | "lane";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

/** A lightweight, UI-safe sample for locating graph bottlenecks. */
export interface GraphPerformanceSample {
  nodeCount: number;
  edgeCount: number;
  labelLayoutMs: number;
  renderCommitMs: number;
  frameIntervalMs: number;
  p95FrameIntervalMs: number;
  simulationAlpha: number;
  edgeLabelsVisible: boolean;
}

export type GraphEdgeLabelMode = "explore" | "review" | "performance";

interface PointerSession {
  mode: "node" | "pan";
  nodeId?: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  moved: boolean;
}

const DEFAULT_COLORS: GraphColorMap = {
  character: "#a84f36",
  place: "#287469",
  faction: "#5d6589",
  object: "#d8ad42",
  event: "#a74f68",
};

/** Estimate label width for pointer hit-testing without a canvas text pass. */
function graphLabelHitWidth(label: string, fontSize: number): number {
  let units = 0;
  for (const glyph of Array.from(label)) {
    const codePoint = glyph.codePointAt(0) ?? 0;
    if (/\s/u.test(glyph)) units += 0.34;
    else if (
      codePoint >= 0x1100 && (
        codePoint <= 0x115f
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xff00 && codePoint <= 0xffef)
        || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      )
    ) units += 1;
    else units += 0.58;
  }
  return Math.max(44, Math.min(176, units * fontSize + 18));
}

export function ForceGraphSvg<NodeMetadata = Record<string, unknown>, EdgeMetadata = Record<string, unknown>>({
  nodes,
  edges,
  width = 700,
  height = 430,
  tuning,
  colors = DEFAULT_COLORS,
  typeLabels,
  selectedNodeId = null,
  edgeLabelMode = "explore",
  resetToken = 0,
  initialAlpha = 1,
  fitOnDataChange = true,
  theme = "light",
  ariaLabel,
  className,
  onNodeSelect,
  onNodeHover,
  onLayoutSnapshot,
  onLayoutFrame,
  onPerformanceSample,
  staticLayout = false,
  mapRegions = [],
}: ForceGraphSvgProps<NodeMetadata, EdgeMetadata>) {
  const visualEdges = useMemo(() => collapseParallelEdges(edges), [edges]);
  const visualSignature = useMemo(() => graphInputSignature(nodes, visualEdges), [nodes, visualEdges]);
  const svgRef = useRef<SVGSVGElement>(null);
  const engineRef = useRef<ForceGraphEngine<NodeMetadata, EdgeMetadata> | null>(null);
  const viewportRef = useRef(
    new SmoothGraphViewport({
      zoomMin: tuning?.zoomMin ?? DEFAULT_GRAPH_TUNING.zoomMin,
      zoomMax: tuning?.zoomMax ?? DEFAULT_GRAPH_TUNING.zoomMax,
      zoomSmoothingMs: tuning?.zoomSmoothingMs ?? DEFAULT_GRAPH_TUNING.zoomSmoothingMs,
    }),
  );
  const pointerRef = useRef<PointerSession | null>(null);
  const previousNodeIdsRef = useRef(new Set(nodes.map((node) => node.id)));
  const previousEdgeIdsRef = useRef(new Set(visualEdges.map((edge) => edge.id)));
  const nodeBornAtRef = useRef(new Map<string, number>());
  const edgeBornAtRef = useRef(new Map<string, number>());
  const fitOnSettleRef = useRef(true);
  const onLayoutSnapshotRef = useRef(onLayoutSnapshot);
  const onLayoutFrameRef = useRef(onLayoutFrame);
  const onPerformanceSampleRef = useRef(onPerformanceSample);
  const snapshotTimerRef = useRef<number | undefined>(undefined);
  const frameRequestedAtRef = useRef<number | null>(null);
  const lastCommitAtRef = useRef<number | null>(null);
  const frameIntervalsRef = useRef<number[]>([]);
  const labelLayoutMsRef = useRef(0);
  const hasMountedGraphRef = useRef(false);
  const viewportAnimationFrameRef = useRef<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const requestViewportAnimation = useCallback(() => {
    if (typeof window === "undefined" || viewportAnimationFrameRef.current !== null) return;
    const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let last = performance.now();
    const animate = (now: number) => {
      const viewport = viewportRef.current;
      const wasAnimating = viewport.isAnimating();
      viewport.step(now - last, reducedMotion);
      last = now;
      if (wasAnimating || viewport.isAnimating()) setFrame(value => value + 1);
      if (viewport.isAnimating()) {
        viewportAnimationFrameRef.current = window.requestAnimationFrame(animate);
      } else {
        viewportAnimationFrameRef.current = null;
      }
    };
    viewportAnimationFrameRef.current = window.requestAnimationFrame(animate);
  }, []);

  useEffect(() => () => {
    if (viewportAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportAnimationFrameRef.current);
      viewportAnimationFrameRef.current = null;
    }
    if (snapshotTimerRef.current !== undefined) {
      window.clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => { onLayoutSnapshotRef.current = onLayoutSnapshot; }, [onLayoutSnapshot]);
  useEffect(() => { onLayoutFrameRef.current = onLayoutFrame; }, [onLayoutFrame]);
  useEffect(() => { onPerformanceSampleRef.current = onPerformanceSample; }, [onPerformanceSample]);

  const emitLayoutSnapshot = () => {
    const engine = engineRef.current;
    if (!engine || !onLayoutSnapshotRef.current) return;
    onLayoutSnapshotRef.current(engine.getNodes(), viewportRef.current.snapshot().actual);
  };

  const scheduleLayoutSnapshot = () => {
    if (snapshotTimerRef.current !== undefined) window.clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = window.setTimeout(emitLayoutSnapshot, 180);
  };

  const fitViewportToNodes = (graphNodes: ReadonlyArray<GraphNodeState<NodeMetadata>>) => {
    if (graphNodes.length === 0) return;
    const bounds = graphNodes.reduce(
      (current, node) => {
        const halfWidth = node.width ? node.width / 2 : node.radius;
        const halfHeight = node.height ? node.height / 2 : node.radius;
        return {
          minX: Math.min(current.minX, node.x - halfWidth),
          minY: Math.min(current.minY, node.y - halfHeight),
          maxX: Math.max(current.maxX, node.x + halfWidth),
          maxY: Math.max(current.maxY, node.y + halfHeight),
        };
      },
      { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY },
    );
    viewportRef.current.fitBounds(bounds, width, height, 110);
    setFrame((value) => value + 1);
    requestViewportAnimation();
  };

  useEffect(() => {
    fitOnSettleRef.current = !hasMountedGraphRef.current || fitOnDataChange;
    const engine = new ForceGraphEngine<NodeMetadata, EdgeMetadata>({
      nodes,
      edges: visualEdges,
      width,
      height,
      ...(tuning ? { tuning } : {}),
    });
    engineRef.current = engine;
    let lastLayoutFrameAt = 0;
    let frameScheduled = false;
    let frameHandle: number | undefined;
    let frameHandleKind: "raf" | "timeout" | undefined;
    const scheduleFrame = () => {
      if (frameScheduled) return;
      frameScheduled = true;
      frameRequestedAtRef.current ??= performance.now();
      const flush = () => {
        frameScheduled = false;
        frameHandle = undefined;
        const now = performance.now();
        setFrame((value) => value + 1);
        if (now - lastLayoutFrameAt >= 80) {
          lastLayoutFrameAt = now;
          onLayoutFrameRef.current?.(engine.getNodes());
        }
      };
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        frameHandleKind = "raf";
        frameHandle = window.requestAnimationFrame(flush);
      } else if (typeof window !== "undefined") {
        frameHandleKind = "timeout";
        frameHandle = window.setTimeout(flush, 16);
      } else {
        flush();
      }
    };
    const unsubscribe = engine.subscribe(() => {
      scheduleFrame();
    });
    const unsubscribeSettled = engine.subscribeSettled(() => {
      if (fitOnSettleRef.current) {
        fitOnSettleRef.current = false;
        fitViewportToNodes(engine.getNodes());
      }
      emitLayoutSnapshot();
    });
    if (staticLayout) {
      // A semantic map is an atlas, not a physics toy. Its coordinates are
      // supplied by the adapter and must remain still after the first paint.
      fitViewportToNodes(engine.getNodes());
    } else {
      engine.restart(Math.max(0.02, Math.min(1, initialAlpha)));
    }
    hasMountedGraphRef.current = true;
    setFrame((value) => value + 1);
    return () => {
      unsubscribe();
      unsubscribeSettled();
      if (frameHandle !== undefined) {
        if (frameHandleKind === "raf") window.cancelAnimationFrame(frameHandle);
        else window.clearTimeout(frameHandle);
      }
      engine.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [fitOnDataChange, height, initialAlpha, staticLayout, visualSignature, width]);

  useEffect(() => {
    const now = performance.now();
    const nextNodeIds = new Set(nodes.map((node) => node.id));
    const nextEdgeIds = new Set(visualEdges.map((edge) => edge.id));
    for (const id of nextNodeIds) {
      if (!previousNodeIdsRef.current.has(id)) nodeBornAtRef.current.set(id, now);
    }
    for (const id of nextEdgeIds) {
      if (!previousEdgeIdsRef.current.has(id)) edgeBornAtRef.current.set(id, now);
    }
    previousNodeIdsRef.current = nextNodeIds;
    previousEdgeIdsRef.current = nextEdgeIds;
  }, [nodes, visualEdges]);

  useEffect(() => {
    engineRef.current?.setTuning(tuning ?? {});
  }, [tuning]);

  useEffect(() => {
    fitOnSettleRef.current = true;
    viewportRef.current.reset(!staticLayout);
    if (staticLayout) {
      const nodes = engineRef.current?.getNodes() ?? [];
      fitViewportToNodes(nodes);
    } else {
      engineRef.current?.restart(0.6);
      requestViewportAnimation();
    }
    setFrame((value) => value + 1);
  }, [requestViewportAnimation, resetToken, staticLayout]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || staticLayout) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const scaleX = width / Math.max(1, rect.width);
      const scaleY = height / Math.max(1, rect.height);
      viewportRef.current.applyWheel({
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        mouseX: (event.clientX - rect.left) * scaleX,
        mouseY: (event.clientY - rect.top) * scaleY,
        pageHeight: height,
      });
      setFrame((value) => value + 1);
      requestViewportAnimation();
      scheduleLayoutSnapshot();
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [height, requestViewportAnimation, staticLayout, width]);

  const engine = engineRef.current;
  const renderedNodes = engine?.getNodes() ?? [];
  const renderedEdges = engine?.getEdges() ?? [];
  const hoveredNode = staticLayout && hoveredNodeId
    ? renderedNodes.find((node) => node.id === hoveredNodeId) ?? null
    : null;
  const viewport = viewportRef.current.snapshot().actual;
  // The SVG viewBox is scaled once more by CSS.  Include that base scale when
  // sizing static-map text; otherwise a healthy world-space font still turns
  // into a tiny glyph when a tall map is fitted into the host panel.
  const svgRect = svgRef.current?.getBoundingClientRect();
  const baseSvgScale = svgRect
    ? Math.min(svgRect.width / Math.max(1, width), svgRect.height / Math.max(1, height))
    : 1;
  const worldScreenScale = Math.max(0.01, viewport.k * Math.max(0.01, baseSvgScale));
  // When the complete directory map is fitted into view, the world transform
  // can make a perfectly healthy 10px SVG label render as a 4–6px glyph. Keep
  // labels in screen space below this readability threshold; the nodes still
  // pan/zoom normally, but their names remain legible without forcing users to
  // zoom all the way to the maximum.
  // Weighted directory tiles carry their own readable labels. Keeping a
  // second screen-space label layer for them would duplicate text and make a
  // dense treemap feel noisy; the exploratory force view still gets the
  // fixed-size fallback labels at low zoom.
  const useReadableScreenLabels = !staticLayout && worldScreenScale < 0.82;
  const connected = useMemo(() => {
    if (!selectedNodeId) return null;
    const result = new Set([selectedNodeId]);
    for (const edge of edges) {
      if (edge.source === selectedNodeId) result.add(edge.target);
      if (edge.target === selectedNodeId) result.add(edge.source);
    }
    return result;
  }, [edges, selectedNodeId]);
  const selectionColors = theme === "dark"
    ? { edge: "#f2c66d", edgeDefault: "#625b64", edgeMuted: "#29252d", label: "#f7dfaa", labelMuted: "#716974", ring: "#f2c66d", type: "#d8cec5", glow: "rgba(242,198,109,.52)" }
    : { edge: "#b77918", edgeDefault: "#9f948a", edgeMuted: "#d8d1c8", label: "#8a5a10", labelMuted: "#aaa198", ring: "#d49a2e", type: "#655d56", glow: "rgba(212,154,46,.42)" };
  // Edge labels are useful in a small narrative graph but become the most
  // expensive SVG layout pass in a dense graph. A selection re-enables the
  // connected labels so the large graph remains inspectable on demand.
  // Exploration keeps the map quiet until the user selects a node. Review is
  // the deliberate audit mode; performance mode removes SVG text entirely.
  const showEdgeLabels = edgeLabelMode === "review"
    || (edgeLabelMode === "explore" && Boolean(selectedNodeId));
  // Cross-directory evidence is a contextual layer. Keep the structural map
  // quiet by default, then reveal only the selected neighborhood (or an
  // explicit review) instead of painting a dense hairball on every frame.
  const visibleEdges = renderedEdges.filter((edge) => {
    if (staticLayout && edge.layout !== "context") {
      // In atlas mode containment is already expressed by the card/region
      // nesting. Only reveal a selected node's parent path on demand.
      return Boolean(selectedNodeId && (edge.source.id === selectedNodeId || edge.target.id === selectedNodeId));
    }
    if (edge.layout !== "context") return true;
    if (edgeLabelMode === "review") return true;
    return Boolean(selectedNodeId && (edge.source.id === selectedNodeId || edge.target.id === selectedNodeId));
  });
  const labelLayoutStartedAt = performance.now();
  const edgeLabelPlacements = showEdgeLabels ? layoutEdgeLabels(visibleEdges, selectedNodeId) : new Map();
  labelLayoutMsRef.current = performance.now() - labelLayoutStartedAt;

  useLayoutEffect(() => {
    const now = performance.now();
    const frameIntervalMs = lastCommitAtRef.current === null ? 0 : now - lastCommitAtRef.current;
    lastCommitAtRef.current = now;
    if (frameIntervalMs > 0) {
      frameIntervalsRef.current = [...frameIntervalsRef.current.slice(-59), frameIntervalMs];
    }
    const sortedIntervals = [...frameIntervalsRef.current].sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(sortedIntervals.length * 0.95) - 1);
    const requestStartedAt = frameRequestedAtRef.current;
    frameRequestedAtRef.current = null;
    onPerformanceSampleRef.current?.({
      nodeCount: renderedNodes.length,
      edgeCount: visibleEdges.length,
      labelLayoutMs: Number(labelLayoutMsRef.current.toFixed(2)),
      renderCommitMs: Number((requestStartedAt === null ? 0 : now - requestStartedAt).toFixed(2)),
      frameIntervalMs: Number(frameIntervalMs.toFixed(2)),
      p95FrameIntervalMs: Number((sortedIntervals[p95Index] ?? 0).toFixed(2)),
      simulationAlpha: Number((engineRef.current?.getAlpha() ?? 0).toFixed(4)),
      edgeLabelsVisible: showEdgeLabels,
    });
  }, [frame, visibleEdges.length, renderedNodes.length, showEdgeLabels]);

  const toGraphPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) * width) / Math.max(1, rect.width);
    const y = ((clientY - rect.top) * height) / Math.max(1, rect.height);
    return { x: (x - viewport.x) / viewport.k, y: (y - viewport.y) / viewport.k };
  };

  const beginNodeDrag = (event: React.PointerEvent<SVGGElement>, nodeId: string) => {
    event.preventDefault();
    event.stopPropagation();
    globalThis.getSelection?.()?.removeAllRanges();
    const node = renderedNodes.find((item) => item.id === nodeId);
    if (!node || (!staticLayout && !engineRef.current?.beginDrag(nodeId))) return;
    pointerRef.current = {
      mode: "node",
      nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: node.x,
      startY: node.y,
      moved: false,
    };
    if (typeof svgRef.current?.setPointerCapture === "function") svgRef.current.setPointerCapture(event.pointerId);
  };

  const beginPan = (event: React.PointerEvent<SVGRectElement>) => {
    if (staticLayout) return;
    event.preventDefault();
    globalThis.getSelection?.()?.removeAllRanges();
    const current = viewportRef.current.snapshot().actual;
    pointerRef.current = {
      mode: "pan",
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: current.x,
      startY: current.y,
      moved: false,
    };
    if (typeof svgRef.current?.setPointerCapture === "function") svgRef.current.setPointerCapture(event.pointerId);
  };

  const movePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const session = pointerRef.current;
    if (!session) return;
    const distance = Math.hypot(event.clientX - session.startClientX, event.clientY - session.startClientY);
    if (distance > 4) session.moved = true;
    if (session.mode === "node" && session.nodeId) {
      // Deterministic map tiles are not physically draggable. The shell still
      // receives the captured pointer events so a tile can be dragged to the
      // depth/action rails, but there is no reason to schedule a React frame
      // for every pixel of that external drag.
      if (staticLayout) return;
      const point = toGraphPoint(event.clientX, event.clientY);
      engineRef.current?.dragTo(session.nodeId, point.x, point.y);
      setFrame((value) => value + 1);
      return;
    }
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    viewportRef.current.panTo(
      session.startX + ((event.clientX - session.startClientX) * width) / Math.max(1, rect.width),
      session.startY + ((event.clientY - session.startClientY) * height) / Math.max(1, rect.height),
    );
    setFrame((value) => value + 1);
  };

  const endPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const session = pointerRef.current;
    if (!session) return;
    if (session.mode === "node" && session.nodeId) {
      if (!staticLayout) engineRef.current?.endDrag(session.nodeId);
      if (!session.moved) onNodeSelect?.(session.nodeId);
    }
    pointerRef.current = null;
    scheduleLayoutSnapshot();
    if (typeof svgRef.current?.hasPointerCapture === "function" && svgRef.current.hasPointerCapture(event.pointerId)) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => () => {
    if (snapshotTimerRef.current !== undefined) window.clearTimeout(snapshotTimerRef.current);
  }, []);

  return (
    <svg
      ref={svgRef}
      aria-label={ariaLabel}
      className={className}
      data-graph-frame={frame}
      data-graph-theme={theme}
      data-graph-static={staticLayout ? "true" : "false"}
      data-initial-alpha={initialAlpha.toFixed(3)}
      data-graph-scale={viewport.k.toFixed(4)}
      onPointerCancel={endPointer}
      onPointerMove={movePointer}
      onPointerUp={endPointer}
      onContextMenu={(event) => event.preventDefault()}
      role="img"
      style={{
        display: "block",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        width: "100%",
      }}
      viewBox={`0 0 ${width} ${height}`}
    >
      <rect fill="transparent" height={height} onPointerDown={beginPan} width={width} x="0" y="0" />
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`}>
        {staticLayout ? mapRegions.slice().sort((left, right) => Number(left.kind !== "area") - Number(right.kind !== "area")).map((region) => (
          <g key={`map-region:${region.id}`} className={`aos-force-map-region is-${region.kind}`} pointerEvents="none">
            <rect fill={region.color} height={region.height} rx={region.kind === "area" ? 26 : 16} width={region.width} x={region.x} y={region.y} />
            <text className="aos-force-map-region-label" fill="#6d5a42" fontSize={String((region.kind === "area" ? 18 : 12) / worldScreenScale)} fontWeight={region.kind === "area" ? "800" : "700"} x={region.x + 20} y={region.y + 28}>{region.label}</text>
          </g>
        )) : null}
        {visibleEdges.map((edge) => {
          const active = !selectedNodeId || edge.source.id === selectedNodeId || edge.target.id === selectedNodeId;
          const contextEdge = edge.layout === "context";
          const bornAt = edgeBornAtRef.current.get(edge.id);
          const progress = bornAt === undefined ? 1 : Math.min(1, Math.max(0.04, (performance.now() - bornAt) / 520));
          return (
            <g key={edge.id} data-edge-id={edge.id} data-edge-layout={edge.layout ?? "force"} data-entering={progress < 1} opacity={active ? contextEdge ? 0.72 : 1 : theme === "dark" ? 0.2 : 0.14}>
              <line pathLength={1} stroke={selectedNodeId ? (active ? selectionColors.edge : selectionColors.edgeMuted) : contextEdge ? "#8e7b8a" : selectionColors.edgeDefault} strokeDasharray={contextEdge ? "0.026 0.018" : 1} strokeDashoffset={contextEdge ? 0 : 1 - progress} strokeWidth={selectedNodeId && active ? contextEdge ? 1.8 : 3 : contextEdge ? 1.1 : active ? 1.5 : 1} x1={edge.source.x} x2={edge.target.x} y1={edge.source.y} y2={edge.target.y} />
              {edgeLabelPlacements.get(edge.id)?.visible ? (() => {
                const placement = edgeLabelPlacements.get(edge.id)!;
                return (
                  <text
                    data-edge-label-id={edge.id}
                    fill={selectedNodeId ? (active ? selectionColors.label : selectionColors.labelMuted) : theme === "dark" ? "#c0b5bd" : "#786f68"}
                    fontSize="10"
                    paintOrder="stroke"
                    pointerEvents="none"
                    stroke={theme === "dark" ? "#17131a" : "#fffaf0"}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="4"
                    textAnchor="middle"
                    x={placement.x}
                    y={placement.y}
                  >
                    <title>{placement.fullLabel}</title>
                    {placement.label}
                  </text>
                );
              })() : null}
            </g>
          );
        })}
        {renderedNodes.map((node) => {
          const displayLabel = node.displayLabel ?? node.label;
          const active = !connected || connected.has(node.id);
          const selected = node.id === selectedNodeId;
          const bornAt = nodeBornAtRef.current.get(node.id);
          const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
          const progress = reducedMotion || bornAt === undefined ? 1 : Math.min(1, Math.max(0.12, (performance.now() - bornAt) / 520));
          const tile = staticLayout && node.width !== undefined && node.height !== undefined;
          const tileWidth = node.width ?? (node.type === "area" ? node.radius * 3.6 : node.radius * 2.6);
          const tileHeight = node.height ?? (node.type === "area" ? node.radius * 0.86 : node.radius * 0.8);
          const nodeTextColor = node.textColor ?? (node.type === "note" ? "#3f3022" : "#fffaf0");
          const staticTileScale = staticLayout ? worldScreenScale : 1;
          const physicalTileWidth = tileWidth * staticTileScale;
          const physicalTileHeight = tileHeight * staticTileScale;
          const tileLabelPixels = Math.max(13, Math.min(20, physicalTileHeight * .18));
          const tileLabelSize = tile ? tileLabelPixels / staticTileScale : Math.max(12, Math.min(22, tileHeight * 0.18));
          const showTileDetails = tile && physicalTileHeight >= 86;
          const nodeShape = tile
            ? <rect height={tileHeight} rx={Math.min(24, Math.max(12, tileHeight * 0.14))} width={tileWidth} x={-tileWidth / 2} y={-tileHeight / 2} />
            : staticLayout && node.type === "area"
            ? <rect height={node.radius * 0.86} rx="18" width={node.radius * 3.6} x={-node.radius * 1.8} y={-node.radius * 0.43} />
            : staticLayout && node.type === "platform"
              ? <rect height={node.radius * 0.82} rx="13" width={node.radius * 2.8} x={-node.radius * 1.4} y={-node.radius * 0.41} />
              : node.type === "area"
                ? <circle cx="0" cy="0" r={node.radius} />
            : node.type === "cluster"
              ? <path d={`M 0 ${-node.radius} L ${node.radius} 0 L 0 ${node.radius} L ${-node.radius} 0 Z`} />
              : <rect height={staticLayout ? node.radius * 0.8 : node.type === "note" ? node.radius * 1.16 : node.radius * 1.35} rx={staticLayout ? 10 : node.type === "note" ? 10 : 14} width={staticLayout ? node.radius * 2.6 : node.radius * 2.05} x={staticLayout ? -node.radius * 1.3 : -node.radius * 1.025} y={staticLayout ? -node.radius * 0.4 : -(node.type === "note" ? node.radius * 0.58 : node.radius * 0.675)} />;
          const labelSize = tile
            ? String(tileLabelSize)
            : staticLayout ? (node.type === "area" ? "14" : node.type === "platform" ? "11" : "10") : (node.type === "note" ? "10" : "11");
          const labelFontSize = Number(labelSize);
          const labelHitWidth = graphLabelHitWidth(displayLabel, labelFontSize);
          const labelHitHeight = Math.max(32, labelFontSize * 2.5);
          return (
            <g
              key={node.id}
              aria-label={`${node.label}，${typeLabels?.[node.type] ?? node.type}`}
              data-node-id={node.id}
              data-node-display-label={displayLabel}
              data-node-x={node.x.toFixed(2)}
              data-node-y={node.y.toFixed(2)}
              data-node-type={node.type}
              data-node-tile={tile ? "true" : "false"}
              data-hovered={node.id === hoveredNodeId}
              data-selected={selected}
              data-entering={progress < 1}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onNodeSelect?.(node.id);
              }}
              onPointerEnter={() => {
                setHoveredNodeId(node.id);
                onNodeHover?.(node.id);
              }}
              onPointerLeave={() => {
                setHoveredNodeId((current) => current === node.id ? null : current);
                onNodeHover?.(null);
              }}
              onPointerDown={(event) => beginNodeDrag(event, node.id)}
              opacity={active ? 1 : theme === "dark" ? 0.28 : 0.2}
              role="button"
              tabIndex={0}
              transform={`translate(${node.x} ${node.y})`}
            >
              <g opacity={progress} transform={`scale(${progress})`}>
                {!tile && !useReadableScreenLabels ? (
                  <rect
                    className="aos-force-node-hit"
                    height={labelHitHeight}
                    pointerEvents="all"
                    rx={labelHitHeight / 2}
                    width={labelHitWidth}
                    x={-labelHitWidth / 2}
                    y={-labelHitHeight / 2}
                  />
                ) : null}
                {React.cloneElement(nodeShape, {
                  fill: node.color ?? colors[node.type] ?? "#7c756f",
                  stroke: selected ? selectionColors.ring : node.accentColor ?? (theme === "dark" ? "#b6ada8" : "#fffaf0"),
                  strokeWidth: selected ? (staticLayout ? 5 : 7) : (staticLayout ? 2 : 4),
                  style: { cursor: "grab", filter: selected ? `drop-shadow(0 0 12px ${selectionColors.glow})` : undefined },
                })}
                {tile ? (
                  <rect
                    className="aos-force-map-tile-accent"
                    fill={node.accentColor ?? node.color ?? "#b47b20"}
                    height={Math.max(18, tileHeight - 10)}
                    pointerEvents="none"
                    rx={Math.min(12, Math.max(6, tileHeight * 0.08))}
                    width={Math.min(9, Math.max(5, tileWidth * 0.035))}
                    x={-tileWidth / 2 + 6}
                    y={-tileHeight / 2 + 5}
                  />
                ) : null}
                <title>{node.label}</title>
                {!useReadableScreenLabels ? (
                  <text fill={nodeTextColor} fontSize={labelSize} fontWeight="800" pointerEvents="none" textAnchor="middle" y={tile ? (showTileDetails ? -6 : 4) : 4}>{displayLabel}</text>
                ) : null}
                {showTileDetails && node.subtitle ? (
                  <text fill={nodeTextColor} fontSize={Math.max(10, tileLabelPixels * 0.62) / staticTileScale} fontWeight="650" opacity=".82" pointerEvents="none" textAnchor="middle" y="15">{node.subtitle}</text>
                ) : null}
                {showTileDetails && node.metric ? (
                  <text fill={nodeTextColor} fontSize={Math.max(9, tileLabelPixels * 0.52) / staticTileScale} fontWeight="650" opacity=".68" pointerEvents="none" textAnchor="middle" y="31">{node.metric}</text>
                ) : null}
                {!staticLayout ? <text data-node-type-label="true" fill={selectionColors.type} fontSize="10" pointerEvents="none" textAnchor="middle" y={node.radius + 20}>{typeLabels?.[node.type] ?? node.type}</text> : null}
              </g>
            </g>
          );
        })}
        {hoveredNode ? (() => {
          const halfWidth = hoveredNode.width ? hoveredNode.width / 2 : hoveredNode.radius;
          const halfHeight = hoveredNode.height ? hoveredNode.height / 2 : hoveredNode.radius;
          // Keep the preview card at a readable screen size even when the
          // entire directory atlas is fitted into a tall, dense map.
          const peekScale = staticLayout ? worldScreenScale : 1;
          const peekWidth = staticLayout ? 300 / peekScale : 246;
          const peekHeight = staticLayout ? 118 / peekScale : 94;
          const preferredX = hoveredNode.x < width / 2
            ? hoveredNode.x + halfWidth + 14
            : hoveredNode.x - halfWidth - peekWidth - 14;
          const peekX = Math.max(14, Math.min(width - peekWidth - 14, preferredX));
          const peekY = Math.max(14, Math.min(height - peekHeight - 14, hoveredNode.y - peekHeight / 2));
          return (
            <g className="aos-force-map-peek" pointerEvents="none" transform={`translate(${peekX} ${peekY})`}>
              <rect height={peekHeight} rx={String(14 / peekScale)} width={peekWidth} x="0" y="0" />
              <text className="aos-force-map-peek-title" fontSize={String(17 / peekScale)} x={String(16 / peekScale)} y={String(28 / peekScale)}>{hoveredNode.label}</text>
              <text className="aos-force-map-peek-subtitle" fontSize={String(12 / peekScale)} x={String(16 / peekScale)} y={String(54 / peekScale)}>{hoveredNode.subtitle ?? "目录入口"}</text>
              <text className="aos-force-map-peek-hint" fontSize={String(10 / peekScale)} x={String(16 / peekScale)} y={String(82 / peekScale)}>{hoveredNode.type === "note" ? "单击打开原文 · Q/W/E/R 切层" : "单击进入 · Q/W/E/R 定深度"}</text>
            </g>
          );
        })() : null}
      </g>
      {useReadableScreenLabels ? (
        <g aria-hidden="true" className="aos-force-screen-labels">
          {renderedNodes.map((node) => {
            const active = !connected || connected.has(node.id);
            const nodeTextColor = node.type === "note" ? "#3f3022" : "#fffaf0";
            const strokeColor = node.type === "note" ? "#fffaf0" : node.type === "area" ? "#9d402f" : node.type === "cluster" ? "#5b4d8e" : "#1b665e";
            const displayLabel = node.displayLabel ?? node.label;
            const screenScale = Math.max(0.01, baseSvgScale);
            const fontSize = 11 / screenScale;
            const hitWidth = graphLabelHitWidth(displayLabel, 11) / screenScale;
            const hitHeight = 32 / screenScale;
            const screenX = viewport.x + node.x * viewport.k;
            const screenY = viewport.y + node.y * viewport.k;
            return (
              <g
                key={`screen-label:${node.id}`}
                data-screen-label-node-id={node.id}
                data-hovered={node.id === hoveredNodeId}
                data-selected={node.id === selectedNodeId}
                onPointerDown={(event) => beginNodeDrag(event, node.id)}
                onPointerEnter={() => {
                  setHoveredNodeId(node.id);
                  onNodeHover?.(node.id);
                }}
                onPointerLeave={() => {
                  setHoveredNodeId((current) => current === node.id ? null : current);
                  onNodeHover?.(null);
                }}
                opacity={active ? 1 : 0.22}
                transform={`translate(${screenX} ${screenY})`}
              >
                <rect
                  className="aos-force-node-hit aos-force-screen-hit"
                  height={hitHeight}
                  pointerEvents="all"
                  rx={hitHeight / 2}
                  width={hitWidth}
                  x={-hitWidth / 2}
                  y={-hitHeight / 2}
                />
                <text
                  fill={nodeTextColor}
                  fontSize={String(fontSize)}
                  fontWeight="800"
                  paintOrder="stroke"
                  pointerEvents="none"
                  stroke={strokeColor}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={String(3 / screenScale)}
                  textAnchor="middle"
                  x="0"
                  y={String(4 / screenScale)}
                >
                  {displayLabel}
                </text>
              </g>
            );
          })}
        </g>
      ) : null}
    </svg>
  );
}
