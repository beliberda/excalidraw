import { newElement, Scene } from "@excalidraw/element";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { getDefaultAppState } from "../appState";
import { Renderer } from "../scene/Renderer";
import {
  buildSpatialIndex,
  querySpatialIndex,
} from "../scene/spatialIndex";

import type { AppState } from "../types";

const rect = (id: string, x: number, y: number, size = 50) =>
  ({
    ...newElement({ type: "rectangle", x, y, width: size, height: size }),
    id,
  } as NonDeletedExcalidrawElement);

describe("spatialIndex (Фаза 4)", () => {
  it("only returns elements whose cell range overlaps the query rect", () => {
    const near = rect("near", 0, 0);
    const far = rect("far", 100_000, 100_000);
    const elementsMap = new Map(
      [near, far].map((el) => [el.id, el]),
    ) as unknown as Parameters<typeof buildSpatialIndex>[1];

    const index = buildSpatialIndex([near, far], elementsMap, 1000);

    const result = querySpatialIndex(
      index,
      { x: -500, y: -500 },
      { x: 500, y: 500 },
    );

    expect(result.map((el) => el.id)).toEqual(["near"]);
  });

  it("dedupes an element spanning multiple cells and preserves z-order across cells", () => {
    // spans cells (0,0) and (1,0) at cellSize 100
    const spanning = rect("spanning", 50, 0, 100);
    // sits only in cell (0,0), but *later* in z-order than `spanning`
    const onTop = rect("onTop", 10, 10, 10);
    const elementsMap = new Map(
      [spanning, onTop].map((el) => [el.id, el]),
    ) as unknown as Parameters<typeof buildSpatialIndex>[1];

    const index = buildSpatialIndex([spanning, onTop], elementsMap, 100);

    // query rect covers both cells (0,0) and (1,0)
    const result = querySpatialIndex(
      index,
      { x: 0, y: 0 },
      { x: 200, y: 50 },
    );

    expect(result).toHaveLength(2);
    // z-order must match the input array order (spanning, then onTop),
    // not cell-merge order
    expect(result.map((el) => el.id)).toEqual(["spanning", "onTop"]);
  });
});

describe("Renderer.getRenderableElements with spatial pre-filter (Фаза 4)", () => {
  const baseAppState = {
    ...getDefaultAppState(),
    width: 1000,
    height: 1000,
    offsetLeft: 0,
    offsetTop: 0,
  } as AppState;

  it("matches a brute-force viewport scan on a widely spread scene", () => {
    const clusterA = Array.from({ length: 5 }, (_, i) =>
      rect(`a${i}`, i * 10, i * 10),
    );
    const clusterB = Array.from({ length: 5 }, (_, i) =>
      rect(`b${i}`, 50_000 + i * 10, 50_000 + i * 10),
    );
    const elements = [...clusterA, ...clusterB];
    const scene = new Scene(elements, { skipValidation: true });
    const renderer = new Renderer(scene);

    // viewport centered on cluster A only, at 100% zoom, no scroll
    const { visibleElements } = renderer.getRenderableElements({
      ...baseAppState,
      zoom: { value: 1 as AppState["zoom"]["value"] },
      scrollX: 0,
      scrollY: 0,
      editingTextElement: null,
      newElement: null,
      selectedElements: [],
      selectedElementsAreBeingDragged: false,
      frameToHighlight: null,
    });

    expect(visibleElements.map((el) => el.id).sort()).toEqual(
      clusterA.map((el) => el.id).sort(),
    );

    // moving the viewport to cluster B instead must pick up B and drop A --
    // regression target for a stale/under-invalidated spatial index cache
    const { visibleElements: visibleElementsB } =
      renderer.getRenderableElements({
        ...baseAppState,
        zoom: { value: 1 as AppState["zoom"]["value"] },
        scrollX: -50_000,
        scrollY: -50_000,
        editingTextElement: null,
        newElement: null,
        selectedElements: [],
        selectedElementsAreBeingDragged: false,
        frameToHighlight: null,
      });

    expect(visibleElementsB.map((el) => el.id).sort()).toEqual(
      clusterB.map((el) => el.id).sort(),
    );
  });

  it("keeps the spatial index in sync after elements move (replaceAllElements rebuilds the array)", () => {
    const moving = rect("moving", 0, 0);
    const elements = [moving];
    const scene = new Scene(elements, { skipValidation: true });
    const renderer = new Renderer(scene);

    const viewportAt = (scrollX: number, scrollY: number) =>
      renderer.getRenderableElements({
        ...baseAppState,
        zoom: { value: 1 as AppState["zoom"]["value"] },
        scrollX,
        scrollY,
        editingTextElement: null,
        newElement: null,
        selectedElements: [],
        selectedElementsAreBeingDragged: false,
        frameToHighlight: null,
      }).visibleElements;

    // visible at its original position
    expect(viewportAt(0, 0).map((el) => el.id)).toEqual(["moving"]);

    // move it far away (new array via replaceAllElements -- real update path)
    scene.replaceAllElements([{ ...moving, x: 100_000, y: 100_000 }]);

    // must no longer show up at the old viewport position
    expect(viewportAt(0, 0).map((el) => el.id)).toEqual([]);
    // and must show up at its new position
    expect(viewportAt(-100_000, -100_000).map((el) => el.id)).toEqual([
      "moving",
    ]);
  });
});
