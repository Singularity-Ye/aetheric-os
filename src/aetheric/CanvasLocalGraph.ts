import { normalizePath } from "obsidian";

export interface CanvasGraphNode {
  id: string; // path
  title: string;
  kind: string;
  depth: number; // 0 = in current folder, 1 = cross-link neighbor
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  pinned?: boolean;
}

export interface CanvasGraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface CanvasLocalGraphData {
  nodes: Array<{ path: string; title: string; kind: string; depth: number }>;
  edges: Array<{ source: string; target: string; weight: number }>;
  folderName: string;
}

export interface CanvasLocalGraphOptions {
  onSelectNode: (path: string) => void;
  onOpenNode: (path: string) => void;
}

export class CanvasLocalGraph {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private options: CanvasLocalGraphOptions;

  private nodes: CanvasGraphNode[] = [];
  private edges: Array<{ source: CanvasGraphNode; target: CanvasGraphNode; weight: number }> = [];
  private nodeById = new Map<string, CanvasGraphNode>();

  private camera = { x: 0, y: 0, zoom: 1 };
  private animFrameId: number | null = null;
  private alpha = 1.0;
  private isDestroyed = false;

  private hoveredNode: CanvasGraphNode | null = null;
  private selectedNodeId: string | null = null;
  private draggedNode: CanvasGraphNode | null = null;
  private isPanning = false;
  private pointerDownPos = { x: 0, y: 0 };
  private pointerLastPos = { x: 0, y: 0 };
  private resizeObserver: ResizeObserver | null = null;

  constructor(container: HTMLElement, options: CanvasLocalGraphOptions) {
    this.container = container;
    this.options = options;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "aos-local-graph-canvas";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    this.canvas.style.cursor = "grab";
    this.container.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context not available");
    this.ctx = ctx;

    this.bindEvents();
    this.resizeCanvas();

    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
      this.render();
    });
    this.resizeObserver.observe(this.container);
  }

  public setData(data: CanvasLocalGraphData, selectedPath: string | null = null): void {
    this.selectedNodeId = selectedPath ? normalizePath(selectedPath) : null;
    this.buildGraph(data);
    this.resetCamera();
    this.startSimulation();
  }

  public setSelectedNode(path: string | null): void {
    const norm = path ? normalizePath(path) : null;
    if (this.selectedNodeId === norm) return;
    this.selectedNodeId = norm;
    this.render();
  }

  public resetView(): void {
    this.resetCamera();
    this.render();
  }

  public restartLayout(): void {
    this.alpha = 1.0;
    this.startSimulation();
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.resizeObserver?.disconnect();
    this.canvas.remove();
  }

  private resizeCanvas(): void {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(100, Math.floor(rect.width));
    const height = Math.max(100, Math.floor(rect.height));

    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.resetTransform?.();
  }

  private buildGraph(data: CanvasLocalGraphData): void {
    this.nodeById.clear();
    const width = this.container.clientWidth || 600;
    const height = this.container.clientHeight || 450;
    const cx = width / 2;
    const cy = height / 2;

    const count = data.nodes.length;
    this.nodes = data.nodes.map((raw, index) => {
      // Arrange initial positions in circular phyllotaxis distribution
      const angle = index * 2.39996; // Golden angle
      const dist = 30 + Math.sqrt(index) * 28;
      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;

      const isCurrentFolder = raw.depth === 0;
      const radius = isCurrentFolder ? 7.5 : 5.5;
      const color = isCurrentFolder ? "#c18a35" : "#3b82a6"; // Gold for folder notes, teal for cross-links

      const node: CanvasGraphNode = {
        id: normalizePath(raw.path),
        title: raw.title || raw.path.split("/").pop()?.replace(/\.md$/, "") || "Untitled",
        kind: raw.kind,
        depth: raw.depth,
        x,
        y,
        vx: 0,
        vy: 0,
        radius,
        color,
      };
      this.nodeById.set(node.id, node);
      return node;
    });

    this.edges = [];
    for (const rawEdge of data.edges) {
      const src = this.nodeById.get(normalizePath(rawEdge.source));
      const tgt = this.nodeById.get(normalizePath(rawEdge.target));
      if (src && tgt && src !== tgt) {
        this.edges.push({ source: src, target: tgt, weight: rawEdge.weight });
      }
    }
  }

  private resetCamera(): void {
    if (this.nodes.length === 0) {
      this.camera = { x: 0, y: 0, zoom: 1 };
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }

    const padding = 70;
    const graphW = Math.max(100, maxX - minX + padding * 2);
    const graphH = Math.max(100, maxY - minY + padding * 2);
    const viewW = this.container.clientWidth || 600;
    const viewH = this.container.clientHeight || 450;

    const zoom = Math.min(1.4, Math.max(0.4, Math.min(viewW / graphW, viewH / graphH)));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    this.camera = {
      x: viewW / 2 - centerX * zoom,
      y: viewH / 2 - centerY * zoom,
      zoom,
    };
  }

  private startSimulation(): void {
    this.alpha = 1.0;
    if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId);

    const step = () => {
      if (this.isDestroyed) return;
      if (this.alpha > 0.005) {
        this.tickPhysics();
        this.render();
        this.alpha *= 0.94; // Decay alpha smoothly (~60-80 frames to rest)
        this.animFrameId = requestAnimationFrame(step);
      } else {
        this.animFrameId = null;
        this.render(); // Final crisp frame
      }
    };
    this.animFrameId = requestAnimationFrame(step);
  }

  private tickPhysics(): void {
    const width = this.container.clientWidth || 600;
    const height = this.container.clientHeight || 450;
    const cx = width / 2;
    const cy = height / 2;
    const kRepel = 700;
    const targetDist = 80;
    const kSpring = 0.045;
    const kCenter = 0.015;
    const count = this.nodes.length;

    // 1. Center gravity & pairwise repulsion
    for (let i = 0; i < count; i++) {
      const a = this.nodes[i];
      if (a.pinned) continue;

      // Center force
      a.vx += (cx - a.x) * kCenter * this.alpha;
      a.vy += (cy - a.y) * kCenter * this.alpha;

      // Repulsion between all pairs
      for (let j = i + 1; j < count; j++) {
        const b = this.nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy + 150;
        const dist = Math.sqrt(distSq);
        const force = (kRepel / distSq) * this.alpha;

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
        if (!b.pinned) { b.vx += fx; b.vy += fy; }
      }
    }

    // 2. Spring attraction along links
    for (const edge of this.edges) {
      const a = edge.source;
      const b = edge.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const delta = dist - targetDist;
      const force = delta * kSpring * this.alpha;

      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (!a.pinned) { a.vx += fx; a.vy += fy; }
      if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
    }

    // 3. Update positions with damping
    const damping = 0.78;
    for (const n of this.nodes) {
      if (n.pinned) continue;
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  private render(): void {
    if (this.isDestroyed) return;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    ctx.save();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(dpr, dpr);

    // Apply camera transform
    ctx.translate(this.camera.x, this.camera.y);
    ctx.scale(this.camera.zoom, this.camera.zoom);

    // Find active connection neighbors for highlight
    const activeId = this.hoveredNode?.id || this.selectedNodeId;
    const neighborIds = new Set<string>();
    if (activeId) {
      neighborIds.add(activeId);
      for (const e of this.edges) {
        if (e.source.id === activeId) neighborIds.add(e.target.id);
        if (e.target.id === activeId) neighborIds.add(e.source.id);
      }
    }

    // 1. Draw Edges
    for (const edge of this.edges) {
      const isConnected = activeId && (edge.source.id === activeId || edge.target.id === activeId);
      const isDimmed = activeId && !isConnected;

      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);

      if (isConnected) {
        ctx.strokeStyle = "rgba(224, 138, 38, 0.9)";
        ctx.lineWidth = 2.2 / this.camera.zoom;
      } else {
        ctx.strokeStyle = isDimmed ? "rgba(160, 160, 160, 0.08)" : "rgba(169, 111, 23, 0.22)";
        ctx.lineWidth = 1.0 / this.camera.zoom;
      }
      ctx.stroke();
    }

    // 2. Draw Nodes
    for (const node of this.nodes) {
      const isSelected = node.id === this.selectedNodeId;
      const isHovered = node === this.hoveredNode;
      const isNeighbor = neighborIds.has(node.id);
      const isDimmed = activeId && !isNeighbor;

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.25 : 1.0;

      // Glow halo for selected/hovered node
      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 6 / this.camera.zoom, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? "rgba(230, 81, 0, 0.3)" : "rgba(193, 138, 53, 0.25)";
        ctx.fill();
      }

      // Main Node Circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();

      // Border outline
      ctx.lineWidth = (isSelected ? 2.5 : 1.2) / this.camera.zoom;
      ctx.strokeStyle = isSelected ? "#e65100" : (isHovered ? "#ffffff" : "rgba(0, 0, 0, 0.25)");
      ctx.stroke();

      ctx.restore();
    }

    // 3. Draw Labels (LOD: Level of Detail)
    const showAllLabels = this.camera.zoom >= 0.75;
    for (const node of this.nodes) {
      const isSelected = node.id === this.selectedNodeId;
      const isHovered = node === this.hoveredNode;
      const isNeighbor = neighborIds.has(node.id);
      const isDimmed = activeId && !isNeighbor;

      const shouldShowLabel = isSelected || isHovered || (showAllLabels && node.depth === 0) || (activeId && isNeighbor);
      if (!shouldShowLabel) continue;

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.3 : 1.0;

      const fontSize = Math.max(10, Math.min(13, 11 / Math.sqrt(this.camera.zoom)));
      ctx.font = `${isSelected || isHovered ? "bold " : ""}${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

      const text = node.title;
      const textMetrics = ctx.measureText(text);
      const textW = textMetrics.width;
      const textH = fontSize;
      const textX = node.x;
      const textY = node.y + node.radius + textH + 2;

      // Label background pill
      ctx.fillStyle = isSelected
        ? "rgba(230, 81, 0, 0.9)"
        : (isHovered ? "rgba(35, 35, 35, 0.88)" : "rgba(248, 246, 240, 0.82)");
      ctx.beginPath();
      const padX = 4;
      const padY = 2;
      ctx.roundRect(
        textX - textW / 2 - padX,
        textY - textH + 1 - padY,
        textW + padX * 2,
        textH + padY * 2,
        3
      );
      ctx.fill();

      // Text itself
      ctx.fillStyle = isSelected || isHovered ? "#ffffff" : "#2b2b2b";
      ctx.textAlign = "center";
      ctx.fillText(text, textX, textY);

      ctx.restore();
    }

    ctx.restore();
  }

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.camera.x) / this.camera.zoom,
      y: (sy - this.camera.y) / this.camera.zoom,
    };
  }

  private findNodeAt(sx: number, sy: number): CanvasGraphNode | null {
    const world = this.screenToWorld(sx, sy);
    const hitSlack = 8 / this.camera.zoom;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = n.x - world.x;
      const dy = n.y - world.y;
      if (dx * dx + dy * dy <= (n.radius + hitSlack) * (n.radius + hitSlack)) {
        return n;
      }
    }
    return null;
  }

  private bindEvents(): void {
    const el = this.canvas;

    el.addEventListener("pointerdown", (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.pointerDownPos = { x: sx, y: sy };
      this.pointerLastPos = { x: sx, y: sy };

      const hit = this.findNodeAt(sx, sy);
      if (hit) {
        this.draggedNode = hit;
        hit.pinned = true;
        el.setPointerCapture(e.pointerId);
      } else {
        this.isPanning = true;
        el.style.cursor = "grabbing";
        el.setPointerCapture(e.pointerId);
      }
    });

    el.addEventListener("pointermove", (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const dx = sx - this.pointerLastPos.x;
      const dy = sy - this.pointerLastPos.y;
      this.pointerLastPos = { x: sx, y: sy };

      if (this.draggedNode) {
        const world = this.screenToWorld(sx, sy);
        this.draggedNode.x = world.x;
        this.draggedNode.y = world.y;
        this.alpha = Math.max(this.alpha, 0.08); // Gently wake springs
        if (this.animFrameId === null) this.startSimulation();
        else this.render();
      } else if (this.isPanning) {
        this.camera.x += dx;
        this.camera.y += dy;
        this.render();
      } else {
        // Hover detection
        const prevHover = this.hoveredNode;
        this.hoveredNode = this.findNodeAt(sx, sy);
        if (this.hoveredNode !== prevHover) {
          el.style.cursor = this.hoveredNode ? "pointer" : "grab";
          this.render();
        }
      }
    });

    const finishPointer = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const dist = Math.hypot(sx - this.pointerDownPos.x, sy - this.pointerDownPos.y);

      if (this.draggedNode) {
        if (dist < 4) {
          // Treated as click on node
          this.selectedNodeId = this.draggedNode.id;
          this.options.onSelectNode(this.draggedNode.id);
        }
        this.draggedNode.pinned = false; // Release node to settle
        this.draggedNode = null;
        if (this.animFrameId === null) this.startSimulation();
      }

      this.isPanning = false;
      el.style.cursor = this.hoveredNode ? "pointer" : "grab";
      try { el.releasePointerCapture(e.pointerId); } catch {}
      this.render();
    };

    el.addEventListener("pointerup", finishPointer);
    el.addEventListener("pointercancel", finishPointer);

    el.addEventListener("dblclick", (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const hit = this.findNodeAt(sx, sy);
      if (hit) {
        this.options.onOpenNode(hit.id);
      } else {
        this.resetView();
      }
    });

    el.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      const newZoom = Math.max(0.2, Math.min(3.5, this.camera.zoom * zoomFactor));

      this.camera.x = mouseX - (mouseX - this.camera.x) * (newZoom / this.camera.zoom);
      this.camera.y = mouseY - (mouseY - this.camera.y) * (newZoom / this.camera.zoom);
      this.camera.zoom = newZoom;

      this.render();
    }, { passive: false });
  }
}
