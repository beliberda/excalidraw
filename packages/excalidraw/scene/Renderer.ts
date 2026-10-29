import {
  getCommonFrameId,
  getElementBounds,
  getFrameChildrenInsertionIndex,
  getContainerElement,
  isElementInViewport,
  isTextElement,
} from "@excalidraw/element";

import {
  arrayToMap,
  memoize,
  toBrandedType,
  viewportCoordsToSceneCoords,
} from "@excalidraw/common";

import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeleted,
  NonDeletedElementsMap,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import type { Scene } from "@excalidraw/element";

import { cancelStaticSceneThrottle } from "../renderer/staticScene";

import { buildSpatialIndex, querySpatialIndex } from "./spatialIndex";

import type { SpatialIndex } from "./spatialIndex";

import type { RenderableElementsMap } from "./types";

import type { AppState, ElementRenderOffsets } from "../types";

type GetRenderableElementsOpts = {
  zoom: AppState["zoom"];
  offsetLeft: AppState["offsetLeft"];
  offsetTop: AppState["offsetTop"];
  scrollX: AppState["scrollX"];
  scrollY: AppState["scrollY"];
  height: AppState["height"];
  width: AppState["width"];
  editingTextElement: AppState["editingTextElement"];
  newElement: AppState["newElement"];
  selectedElements: readonly NonDeletedExcalidrawElement[];
  selectedElementsAreBeingDragged: AppState["selectedElementsAreBeingDragged"];
  frameToHighlight: AppState["frameToHighlight"];
};

export class Renderer {
  private scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /**
   * Adjusts the document-visible set for render-override translations: an
   * element leaves it when its offset moves it out of view and enters it when
   * its offset brings it in; everything else keeps its document visibility.
   * Only translated elements go through viewport geometry. The result is
   * memoized on the offsets' identity so that opacity-only snapshots don't
   * reach it at all.
   */
  public getVisibleElementsWithRenderOffsets(
    visibleElements: readonly NonDeletedExcalidrawElement[],
    elementsMap: RenderableElementsMap,
    appState: AppState,
    offsets: ElementRenderOffsets,
  ) {
    return this._getVisibleElementsWithRenderOffsets({
      visibleElements,
      elementsMap,
      offsets,
      zoom: appState.zoom,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      offsetLeft: appState.offsetLeft,
      offsetTop: appState.offsetTop,
      width: appState.width,
      height: appState.height,
      selectedElements: this.scene.getSelectedElements(appState),
      frameToHighlight: appState.selectedElementsAreBeingDragged
        ? appState.frameToHighlight
        : null,
    });
  }

  private _getVisibleElementsWithRenderOffsets = memoize(
    ({
      visibleElements,
      elementsMap,
      offsets,
      selectedElements,
      frameToHighlight,
      ...viewport
    }: Pick<
      GetRenderableElementsOpts,
      | "zoom"
      | "scrollX"
      | "scrollY"
      | "offsetLeft"
      | "offsetTop"
      | "width"
      | "height"
      | "selectedElements"
      | "frameToHighlight"
    > & {
      visibleElements: readonly NonDeletedExcalidrawElement[];
      elementsMap: RenderableElementsMap;
      offsets: ElementRenderOffsets;
    }) => {
      // Shifting the viewport instead of the element also works for arrow
      // labels, whose coordinates derive from their container.
      const isVisible = (
        element: NonDeletedExcalidrawElement,
        offset: ElementRenderOffsets extends ReadonlyMap<string, infer T>
          ? T
          : never,
      ) =>
        isElementInViewport(
          element,
          viewport.width,
          viewport.height,
          {
            ...viewport,
            scrollX: viewport.scrollX + offset.x,
            scrollY: viewport.scrollY + offset.y,
          },
          elementsMap,
        );

      const documentVisible = this.getVisibleSet(visibleElements);
      const added = new Set<NonDeletedExcalidrawElement>();
      const removed = new Set<NonDeletedExcalidrawElement>();
      const update = (
        element: NonDeletedExcalidrawElement,
        visible: boolean,
      ) => {
        if (documentVisible.has(element) !== visible) {
          (visible ? added : removed).add(element);
        }
      };
      for (const [id, offset] of offsets) {
        const element = elementsMap.get(id);
        // A bound label's own offset is ignored, and it needs no entry of
        // its own: the static renderer draws it with its container and skips
        // its entry, so its document visibility can stay as it is.
        if (
          !element ||
          (isTextElement(element) && getContainerElement(element, elementsMap))
        ) {
          continue;
        }
        update(element, isVisible(element, offset));
      }

      if (!added.size && !removed.size) {
        return visibleElements;
      }

      const needsFrameReordering =
        frameToHighlight &&
        getCommonFrameId(selectedElements) !== frameToHighlight.id;
      if (!added.size && !needsFrameReordering) {
        return visibleElements.filter((element) => !removed.has(element));
      }

      // Rebuild in scene order when elements enter the view. Frame-drag
      // ordering also needs rebuilding on removals, since the anchoring frame
      // may have left the view.
      const result: NonDeletedExcalidrawElement[] = [];
      for (const element of elementsMap.values()) {
        if (
          added.has(element) ||
          (documentVisible.has(element) && !removed.has(element))
        ) {
          result.push(element);
        }
      }
      return needsFrameReordering
        ? this.sortSelectedElementsIntoHighlightedFrame({
            visibleElements: result,
            selectedElements,
            frameToHighlight,
          })
        : result;
    },
  );

  /** the document-visible elements as a set, cached per visible array */
  private visibleSets = new WeakMap<
    readonly NonDeletedExcalidrawElement[],
    Set<NonDeletedExcalidrawElement>
  >();

  private getVisibleSet(
    visibleElements: readonly NonDeletedExcalidrawElement[],
  ) {
    let set = this.visibleSets.get(visibleElements);
    if (!set) {
      set = new Set(visibleElements);
      this.visibleSets.set(visibleElements, set);
    }
    return set;
  }

  // Фаза 4 (zoom-render-performance-plan.md §6): keyed on the *stable*
  // non-deleted elements array (`scene.getNonDeletedElements()`), which only
  // changes identity when scene data actually changes -- not on every
  // pan/zoom tick, unlike the `elementsMap` rebuilt fresh per render pass in
  // `_getRenderableElements` below (it additionally excludes the
  // currently-edited text element/newElement, which isn't scene data).
  private spatialIndexCache = new WeakMap<
    readonly NonDeletedExcalidrawElement[],
    SpatialIndex
  >();

  private getSpatialIndex(
    elements: readonly NonDeletedExcalidrawElement[],
    elementsMap: NonDeletedElementsMap,
  ): SpatialIndex {
    let index = this.spatialIndexCache.get(elements);
    if (!index) {
      index = buildSpatialIndex(elements, elementsMap);
      this.spatialIndexCache.set(elements, index);
    }
    return index;
  }

  private getVisibleCanvasElements({
    elementsMap,
    zoom,
    offsetLeft,
    offsetTop,
    scrollX,
    scrollY,
    height,
    width,
  }: {
    elementsMap: NonDeletedElementsMap;
    zoom: AppState["zoom"];
    offsetLeft: AppState["offsetLeft"];
    offsetTop: AppState["offsetTop"];
    scrollX: AppState["scrollX"];
    scrollY: AppState["scrollY"];
    height: AppState["height"];
    width: AppState["width"];
  }): readonly NonDeletedExcalidrawElement[] {
    // isElementInViewport() re-derives the viewport's own scene-space corners
    // (two viewportCoordsToSceneCoords() calls, each allocating a point and a
    // fresh viewport-transformations object) on every call, even though those
    // corners don't depend on the element at all. Hoisting that out of the
    // loop turns a per-element cost into a per-frame one — on scenes with
    // 1000+ elements this loop runs on every pan/zoom tick, so the per-element
    // allocations were a measurable chunk of the per-tick JS cost.
    const viewTransformations = {
      zoom,
      offsetLeft,
      offsetTop,
      scrollX,
      scrollY,
    };
    const topLeft = viewportCoordsToSceneCoords(
      { clientX: offsetLeft, clientY: offsetTop },
      viewTransformations,
    );
    const bottomRight = viewportCoordsToSceneCoords(
      { clientX: offsetLeft + width, clientY: offsetTop + height },
      viewTransformations,
    );

    // Pre-filters via the grid before paying the (already cheap, but still
    // per-element) bounds-lookup + comparison cost below -- on a scene
    // spread out over far more area than one viewport, most elements never
    // even get touched. On zoom-to-fit the viewport covers the whole scene,
    // so this candidate set is the full scene anyway -- no regression there,
    // just no win either (see module doc in `spatialIndex.ts`).
    const candidates = querySpatialIndex(
      this.getSpatialIndex(this.scene.getNonDeletedElements(), elementsMap),
      topLeft,
      bottomRight,
    );

    const visibleElements: NonDeletedExcalidrawElement[] = [];
    for (const candidate of candidates) {
      // the per-render-pass `elementsMap` can omit the candidate (currently
      // being edited text / the in-progress new element aren't "scene data"
      // the index was built from) -- skip rather than fall back to the
      // index's own copy, so behavior matches the pre-Фаза-4 full scan.
      const element = elementsMap.get(candidate.id);
      if (!element) {
        continue;
      }
      const [x1, y1, x2, y2] = getElementBounds(element, elementsMap);
      if (
        topLeft.x <= x2 &&
        topLeft.y <= y2 &&
        bottomRight.x >= x1 &&
        bottomRight.y >= y1
      ) {
        visibleElements.push(element);
      }
    }
    return visibleElements;
  }

  private getRenderableElementsMap({
    elements,
    editingTextElement,
    newElement,
  }: {
    elements: readonly NonDeletedExcalidrawElement[];
    editingTextElement: AppState["editingTextElement"];
    newElement: AppState["newElement"];
  }) {
    const elementsMap = toBrandedType<RenderableElementsMap>(new Map());
    const newElementCanvasElement = newElement?.frameId ? null : newElement;

    for (const element of elements) {
      if (newElementCanvasElement?.id === element.id) {
        continue;
      }

      // we don't want to render text element that's being currently edited
      // (it's rendered on remote only)
      if (
        !editingTextElement ||
        editingTextElement.type !== "text" ||
        element.id !== editingTextElement.id
      ) {
        elementsMap.set(element.id, element);
      }
    }
    return { elementsMap, newElementCanvasElement };
  }

  private sortSelectedElementsIntoHighlightedFrame<
    T extends ExcalidrawElement,
  >({
    visibleElements,
    selectedElements,
    frameToHighlight,
  }: {
    selectedElements: readonly NonDeletedExcalidrawElement[];
    visibleElements: readonly T[];
    frameToHighlight: NonDeleted<ExcalidrawFrameLikeElement>;
  }): readonly T[] {
    if (!selectedElements.length) {
      return visibleElements;
    }

    // we assume all selected elements are eligible frame children if
    // frameToHighlight is defined
    const selectedElementsMap = arrayToMap(selectedElements);

    // thus, all deselected elements are the ones we won't reorder
    const deselectedElements = visibleElements.filter(
      (element) => !selectedElementsMap.has(element.id),
    );

    const insertionIndex = getFrameChildrenInsertionIndex(
      deselectedElements,
      frameToHighlight.id,
    );

    if (insertionIndex === null) {
      return visibleElements;
    }

    return [
      ...deselectedElements.slice(0, insertionIndex),
      ...selectedElements,
      ...deselectedElements.slice(insertionIndex),
    ] as readonly T[];
  }

  private _getRenderableElements = memoize(
    ({
      canvasNonce,
      zoom,
      offsetLeft,
      offsetTop,
      scrollX,
      scrollY,
      height,
      width,
      editingTextElement,
      newElement,
    }: Omit<
      GetRenderableElementsOpts,
      | "selectedElements"
      | "selectedElementsAreBeingDragged"
      | "frameToHighlight"
    > & {
      canvasNonce: string;
    }) => {
      const elements = this.scene.getNonDeletedElements();

      const { elementsMap, newElementCanvasElement } =
        this.getRenderableElementsMap({
          elements,
          editingTextElement,
          newElement,
        });

      const visibleElements = this.getVisibleCanvasElements({
        elementsMap,
        zoom,
        offsetLeft,
        offsetTop,
        scrollX,
        scrollY,
        height,
        width,
      });

      return {
        elementsMap,
        visibleElements,
        newElementCanvasElement,
        canvasNonce,
      };
    },
  );

  public getRenderableElements = (opts: GetRenderableElementsOpts) => {
    const { newElement } = opts;
    // A new element being drag-sized is mutated in place without informing
    // the scene, so `sceneNonce` doesn't move. Fold the element's own nonce
    // in where a canvas draws it from the live element but memoizes on this
    // nonce: a framed new element stays in the static canvas' element map
    // (see getRenderableElementsMap), and a new text gets its dashed text box
    // drawn by the interactive canvas (it doubles as `editingTextElement`).
    const canvasNonce = `${this.scene.getSceneNonce()}${
      newElement?.frameId || isTextElement(newElement)
        ? `:${newElement.versionNonce}`
        : ""
    }`;

    const ret = this._getRenderableElements({
      canvasNonce,

      // don't spread `opts` because we don't want to memoize on some props

      zoom: opts.zoom,
      offsetLeft: opts.offsetLeft,
      offsetTop: opts.offsetTop,
      scrollX: opts.scrollX,
      scrollY: opts.scrollY,
      height: opts.height,
      width: opts.width,
      editingTextElement: opts.editingTextElement,
      newElement: opts.newElement,
    });

    // if we're dragging elements over a frame, reorder the selected elements
    // inside the frame during render (we don't set the `element.frameId` until
    // pointerup else we'd have to painstainly restore the orig index if user
    // didn't end up adding elements to the frame)
    if (
      opts.frameToHighlight &&
      opts.selectedElementsAreBeingDragged &&
      // if all dragged elements are already in the frame, don't reorder
      getCommonFrameId(opts.selectedElements) !== opts.frameToHighlight.id
    ) {
      const reorderedVisibleElements =
        this.sortSelectedElementsIntoHighlightedFrame({
          visibleElements: ret.visibleElements,
          selectedElements: opts.selectedElements,
          frameToHighlight: opts.frameToHighlight,
        });

      return {
        ...ret,
        visibleElements: reorderedVisibleElements,
      };
    }

    return ret;
  };

  // NOTE Doesn't destroy everything (scene, rc, etc.) because it may not be
  // safe to break TS contract here (for upstream cases)
  public destroy(staticCanvas: HTMLCanvasElement) {
    cancelStaticSceneThrottle(staticCanvas);
    this._getRenderableElements.clear();
    this._getVisibleElementsWithRenderOffsets.clear();
  }
}
