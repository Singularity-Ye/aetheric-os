import type {
  GraphTransform,
  GraphTuning,
  GraphViewportSnapshot,
  GraphWheelInput,
} from "./types";

const cloneTransform = (value: GraphTransform): GraphTransform => ({ ...value });

export function normalizeWheelDelta(deltaY: number, deltaMode: number, pageHeight: number) {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}

export class SmoothGraphViewport {
  readonly tuning: Pick<GraphTuning, "zoomMin" | "zoomMax" | "zoomSmoothingMs">;
  private actual: GraphTransform;
  private target: GraphTransform;

  constructor(
    tuning: Pick<GraphTuning, "zoomMin" | "zoomMax" | "zoomSmoothingMs">,
    initial: GraphTransform = { x: 0, y: 0, k: 1 },
  ) {
    this.tuning = tuning;
    this.actual = cloneTransform(initial);
    this.target = cloneTransform(initial);
  }

  snapshot(): GraphViewportSnapshot {
    return { actual: cloneTransform(this.actual), target: cloneTransform(this.target) };
  }

  applyWheel(input: GraphWheelInput) {
    const delta = normalizeWheelDelta(input.deltaY, input.deltaMode, input.pageHeight);
    const oldScale = this.target.k;
    const nextScale = Math.max(
      this.tuning.zoomMin,
      Math.min(this.tuning.zoomMax, oldScale * Math.exp(-delta * 0.00135)),
    );
    this.target.x = input.mouseX - ((input.mouseX - this.target.x) * nextScale) / oldScale;
    this.target.y = input.mouseY - ((input.mouseY - this.target.y) * nextScale) / oldScale;
    this.target.k = nextScale;
    return this.snapshot();
  }

  panTo(x: number, y: number) {
    this.actual.x = x;
    this.actual.y = y;
    this.target = cloneTransform(this.actual);
    return this.snapshot();
  }

  reset(animated = true) {
    this.target = { x: 0, y: 0, k: 1 };
    if (!animated) this.actual = cloneTransform(this.target);
    return this.snapshot();
  }

  /** Center the current graph bounds in the SVG viewport with breathing room. */
  fitBounds(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    viewportWidth: number,
    viewportHeight: number,
    padding = 84,
  ) {
    const graphWidth = Math.max(1, bounds.maxX - bounds.minX);
    const graphHeight = Math.max(1, bounds.maxY - bounds.minY);
    const availableWidth = Math.max(1, viewportWidth - padding * 2);
    const availableHeight = Math.max(1, viewportHeight - padding * 2);
    const nextScale = Math.max(
      this.tuning.zoomMin,
      Math.min(this.tuning.zoomMax, Math.min(availableWidth / graphWidth, availableHeight / graphHeight)),
    );
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    this.target = {
      x: viewportWidth / 2 - centerX * nextScale,
      y: viewportHeight / 2 - centerY * nextScale,
      k: nextScale,
    };
    return this.snapshot();
  }

  step(deltaMs: number, reducedMotion = false) {
    const boundedDelta = Math.max(0, Math.min(40, deltaMs));
    const ease = reducedMotion
      ? 1
      : 1 - Math.exp(-boundedDelta / Math.max(1, this.tuning.zoomSmoothingMs));
    this.actual.x += (this.target.x - this.actual.x) * ease;
    this.actual.y += (this.target.y - this.actual.y) * ease;
    this.actual.k += (this.target.k - this.actual.k) * ease;
    if (Math.abs(this.target.x - this.actual.x) < 0.0001) this.actual.x = this.target.x;
    if (Math.abs(this.target.y - this.actual.y) < 0.0001) this.actual.y = this.target.y;
    if (Math.abs(this.target.k - this.actual.k) < 0.0001) this.actual.k = this.target.k;
    return this.snapshot();
  }

  isAnimating() {
    return (
      Math.abs(this.target.x - this.actual.x) >= 0.0001 ||
      Math.abs(this.target.y - this.actual.y) >= 0.0001 ||
      Math.abs(this.target.k - this.actual.k) >= 0.0001
    );
  }
}
