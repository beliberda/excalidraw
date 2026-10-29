import { getElementBounds } from "@excalidraw/element";

import type {
  NonDeletedElementsMap,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

/**
 * Фаза 4 (zoom-render-performance-plan.md §6): a uniform-grid pre-filter for
 * `Renderer.getVisibleCanvasElements` — see references §6/Фаза4 (upstream
 * issue #10063, PRs #10514/#11463, none merged, no benchmarks in either;
 * written from scratch here, not ported).
 *
 * Does NOT help zoom-to-fit (the whole point of this plan's other phases):
 * at that zoom every element is visible anyway, so a spatial pre-filter has
 * nothing to prune. It helps ordinary pan/zoom on a scene whose elements are
 * spread out over an area much larger than one viewport — e.g. several
 * distant clusters of drawings — where the current viewport only ever
 * overlaps a small fraction of the scene. `getElementBounds` is already
 * cached per element (version-keyed `WeakMap`, see `bounds.ts`), so the win
 * here isn't cheaper bounds math, it's *not touching* the majority of
 * elements at all on every pan/zoom tick.
 *
 * Elements are bucketed into fixed-size square cells by their bounds; a
 * query collects every element whose cell range overlaps the viewport's
 * cell range. This is a deliberately coarse pre-filter -- the caller still
 * runs the exact same precise bbox-vs-viewport comparison it always did,
 * just over the (hopefully much smaller) candidate set instead of every
 * element in the scene. Coarseness can only ever over-include a candidate
 * (an element whose cell overlaps but whose actual bbox doesn't), never
 * drop one that should be visible -- soundness doesn't depend on cell size.
 */

interface IndexedElement {
  element: NonDeletedExcalidrawElement;
  /** position in the `elements` array the index was built from -- used to
   * restore z-order after merging candidates from multiple cells, since
   * cell iteration order has no relation to it. */
  zIndex: number;
}

export interface SpatialIndex {
  readonly cellSize: number;
  readonly cells: Map<string, IndexedElement[]>;
}

/**
 * NOT calibrated (tracked in §8 of the plan doc) -- scene-space units, same
 * space as element x/y/width/height. Per the plan's methodology (§6), this
 * should be tuned by measuring query cost vs. candidate-set size on a real
 * widely-spread scene; this starting value is a reasoned guess (a few
 * typical elements per cell at 100% zoom), not a measured one.
 */
export const SPATIAL_INDEX_CELL_SIZE = 1000;

const cellKey = (cellX: number, cellY: number) => `${cellX},${cellY}`;

export const buildSpatialIndex = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: NonDeletedElementsMap,
  cellSize: number = SPATIAL_INDEX_CELL_SIZE,
): SpatialIndex => {
  const cells = new Map<string, IndexedElement[]>();

  for (let zIndex = 0; zIndex < elements.length; zIndex++) {
    const element = elements[zIndex];
    const [x1, y1, x2, y2] = getElementBounds(element, elementsMap);
    const cellX1 = Math.floor(x1 / cellSize);
    const cellY1 = Math.floor(y1 / cellSize);
    const cellX2 = Math.floor(x2 / cellSize);
    const cellY2 = Math.floor(y2 / cellSize);

    for (let cellX = cellX1; cellX <= cellX2; cellX++) {
      for (let cellY = cellY1; cellY <= cellY2; cellY++) {
        const key = cellKey(cellX, cellY);
        let bucket = cells.get(key);
        if (!bucket) {
          bucket = [];
          cells.set(key, bucket);
        }
        bucket.push({ element, zIndex });
      }
    }
  }

  return { cellSize, cells };
};

/**
 * Returns every element whose cell range overlaps `[topLeft, bottomRight]`
 * (scene-space), deduplicated and restored to the z-order of the `elements`
 * array the index was built from -- cell iteration order has no relation to
 * z-order (an element can land in a cell visited early despite being drawn
 * last), so results are explicitly re-sorted by the index each element was
 * built with rather than relying on merge order.
 */
export const querySpatialIndex = (
  index: SpatialIndex,
  topLeft: { x: number; y: number },
  bottomRight: { x: number; y: number },
): NonDeletedExcalidrawElement[] => {
  const { cellSize, cells } = index;
  const cellX1 = Math.floor(topLeft.x / cellSize);
  const cellY1 = Math.floor(topLeft.y / cellSize);
  const cellX2 = Math.floor(bottomRight.x / cellSize);
  const cellY2 = Math.floor(bottomRight.y / cellSize);

  const seen = new Set<string>();
  const candidates: IndexedElement[] = [];

  for (let cellX = cellX1; cellX <= cellX2; cellX++) {
    for (let cellY = cellY1; cellY <= cellY2; cellY++) {
      const bucket = cells.get(cellKey(cellX, cellY));
      if (!bucket) {
        continue;
      }
      for (const candidate of bucket) {
        if (!seen.has(candidate.element.id)) {
          seen.add(candidate.element.id);
          candidates.push(candidate);
        }
      }
    }
  }

  candidates.sort((a, b) => a.zIndex - b.zIndex);
  return candidates.map((candidate) => candidate.element);
};
