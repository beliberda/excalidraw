/**
 * Фаза 5 (zoom-render-performance-plan.md §6): pan-reuse — on a *pure*
 * scroll change (nothing else about the frame changed), shift the static
 * canvas' already-rendered pixels by the exact scroll delta instead of
 * repainting the whole canvas, then only repaint the thin strip(s) newly
 * exposed at the edge(s) the pan revealed.
 *
 * This is the second half of the idea behind upstream PR #12211 (see Фаза 1
 * in the plan doc) — made independently, not ported: the reviewer there
 * found a grid-phase mismatch bug between the copied middle and the
 * freshly-painted edge strips. The design here avoids that *structurally*
 * rather than by being more careful with the same approach: `staticScene.ts`
 * paints an edge strip by calling the exact same full-repaint function
 * (`__renderStaticScene`) used for every other frame, with the canvas
 * context clipped to the strip's rect — so the strip's grid/elements are
 * computed by the identical code path a full repaint would use, not a
 * parallel reimplementation that could drift out of sync with it. Pure
 * functions below only decide *whether* a tick qualifies and *where* the
 * exposed strips are; they hold no canvas/DOM dependency, so they're
 * directly unit-testable without a browser or a canvas mock.
 *
 * Correctness invariant this relies on: `scrollX`/`scrollY` are snapped to
 * whole device pixels before this runs (`snapScrollToDevicePixels`, already
 * used elsewhere for the same reason — see `canSnapElement` in
 * `renderElement.ts`). Because of that, `dx`/`dy` below are always a whole
 * number of device pixels, which means shifting old pixels by `dx`/`dy` is
 * pixel-identical to what repainting at the new scroll would have produced
 * in that same region — a whole-pixel shift can't change any element's
 * sub-pixel alignment against the device-pixel grid. Any field that this
 * guarantee depends on (zoom, scale, canvas size, the snapped scroll itself)
 * is part of the eligibility check below; anything not accounted for there
 * must make the eligibility check return `null` (full repaint is always
 * correct — reuse only ever trades correctness-preserving work for less
 * work, never the other way round).
 */

export interface PanReuseEligibilitySnapshot {
  /** see `StaticSceneRenderConfig["canvasNonce"]` -- the one thing that
   * stands in for "did scene data (or the editing/new-element/selection
   * state baked into it) change" without re-deriving it here. */
  canvasNonce: string;
  zoomValue: number;
  /** backing-store scale, `StaticSceneRenderConfig["scale"]` */
  scale: number;
  /** raw canvas pixel dimensions (`canvas.width`/`canvas.height`), not the
   * scale-normalized ones -- this is the space `dx`/`dy` and the bands below
   * are computed in. */
  width: number;
  height: number;
  theme: string;
  renderGrid: boolean;
  gridSize: number;
  gridStep: number;
  viewBackgroundColor: string | null;
  /** already snapped to whole device pixels by the caller. */
  scrollX: number;
  scrollY: number;
}

export interface PanReuseBand {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanReusePlan {
  /** whole device pixels -- the shift applied to the previous frame's pixels. */
  dx: number;
  dy: number;
  /** the newly-exposed strip(s), raw canvas pixel space, to repaint. At most
   * one per axis that moved -- a diagonal pan's corner is covered by both
   * (and so repainted twice), which is harmless, just a few wasted pixels. */
  bands: PanReuseBand[];
}

/**
 * `null` means "not eligible, do a normal full repaint" -- the only two
 * outcomes. There's no partial-eligibility, no quality knob: the whole point
 * is this is a pure optimization that a full repaint remains the correct,
 * unconditional fallback for.
 */
export const computePanReusePlan = (
  prev: PanReuseEligibilitySnapshot | undefined,
  next: PanReuseEligibilitySnapshot,
): PanReusePlan | null => {
  if (
    !prev ||
    prev.canvasNonce !== next.canvasNonce ||
    prev.zoomValue !== next.zoomValue ||
    prev.scale !== next.scale ||
    prev.width !== next.width ||
    prev.height !== next.height ||
    prev.theme !== next.theme ||
    prev.renderGrid !== next.renderGrid ||
    prev.gridSize !== next.gridSize ||
    prev.gridStep !== next.gridStep ||
    prev.viewBackgroundColor !== next.viewBackgroundColor
  ) {
    return null;
  }

  const devicePixels = next.zoomValue * next.scale;
  const dx = Math.round((next.scrollX - prev.scrollX) * devicePixels);
  const dy = Math.round((next.scrollY - prev.scrollY) * devicePixels);

  if (dx === 0 && dy === 0) {
    // nothing moved (everything else already compared equal above) --
    // nothing to reuse, and nothing to gain by pretending otherwise.
    return null;
  }

  if (Math.abs(dx) >= next.width || Math.abs(dy) >= next.height) {
    // the shift leaves no overlap between old and new content -- a full
    // repaint IS the "exposed strip" in this case, so reuse buys nothing
    // and the band math below (which assumes a strip strictly smaller than
    // the canvas) would produce a band covering the whole canvas anyway.
    return null;
  }

  const bands: PanReuseBand[] = [];
  if (dx > 0) {
    bands.push({ x: 0, y: 0, w: dx, h: next.height });
  } else if (dx < 0) {
    bands.push({ x: next.width + dx, y: 0, w: -dx, h: next.height });
  }
  if (dy > 0) {
    bands.push({ x: 0, y: 0, w: next.width, h: dy });
  } else if (dy < 0) {
    bands.push({ x: 0, y: next.height + dy, w: next.width, h: -dy });
  }

  return { dx, dy, bands };
};

/**
 * Converts a band (raw canvas pixel space) to the scene-space rect it
 * covers, using the same `scenePos = rawPos / devicePixels - scroll`
 * inverse as the forward transform chain
 * (`bootstrapCanvas`'s `scale(scale)` → `__renderStaticScene`'s
 * `scale(zoom.value)` → each element's `translate(x + scrollX, y + scrollY)`).
 */
export const sceneRectForBand = (
  band: PanReuseBand,
  scrollX: number,
  scrollY: number,
  devicePixels: number,
): { x1: number; y1: number; x2: number; y2: number } => ({
  x1: band.x / devicePixels - scrollX,
  y1: band.y / devicePixels - scrollY,
  x2: (band.x + band.w) / devicePixels - scrollX,
  y2: (band.y + band.h) / devicePixels - scrollY,
});
