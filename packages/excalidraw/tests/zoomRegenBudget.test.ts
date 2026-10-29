// @vitest-environment-options {"url": "http://localhost/"}

import { RoughCanvas } from "roughjs/bin/canvas";
import { RoughGenerator } from "roughjs/bin/generator";

import { newElement } from "@excalidraw/element";

import { vi } from "vitest";

import type { RenderEnvironment } from "@excalidraw/element/renderEnvironment";

import type {
  ElementsMap,
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import { getDefaultAppState } from "../appState";
import { renderStaticScene } from "../renderer/staticScene";
import { regenerateDeferredZoomBitmaps } from "@excalidraw/element";

import type { StaticCanvasAppState } from "../types";
import type {
  RenderableElementsMap,
  StaticSceneRenderConfig,
} from "../scene/types";

const makeDecodedImage = () => {
  const image = document.createElement("img");
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "naturalWidth", { value: 16 });
  return image;
};

const makeEnv = (onCreateCanvas?: () => void) => {
  const canvases: HTMLCanvasElement[] = [];
  const env: RenderEnvironment = {
    createCanvas: () => {
      onCreateCanvas?.();
      const canvas = document.createElement("canvas");
      canvases.push(canvas);
      return canvas;
    },
    createImage: makeDecodedImage,
  };
  return { env, canvases };
};

const makeScene = () =>
  Object.assign(document.createElement("canvas"), {
    width: 1000,
    height: 1000,
  });

const baseAppState = {
  ...getDefaultAppState(),
  width: 1000,
  height: 1000,
  offsetLeft: 0,
  offsetTop: 0,
} as StaticCanvasAppState;

const makeConfig = (
  elements: NonDeletedExcalidrawElement[],
  {
    zoomValue,
    shouldCacheIgnoreZoom,
    renderEnvironment,
    canvas,
  }: {
    zoomValue: number;
    shouldCacheIgnoreZoom?: boolean;
    renderEnvironment: RenderEnvironment;
    canvas: HTMLCanvasElement;
  },
): StaticSceneRenderConfig => {
  const elementsMap = new Map(
    elements.map((element) => [element.id, element]),
  ) as unknown as ElementsMap;

  const appState = {
    ...baseAppState,
    zoom: { value: zoomValue },
    shouldCacheIgnoreZoom: !!shouldCacheIgnoreZoom,
  } as StaticCanvasAppState;

  return {
    canvas,
    rc: new RoughCanvas(canvas),
    elementsMap: elementsMap as unknown as RenderableElementsMap,
    allElementsMap: elementsMap as unknown as NonDeletedSceneElementsMap,
    visibleElements: elements,
    scale: 1,
    appState,
    renderConfig: {
      canvasBackgroundColor: "",
      scale: 1,
      imageCache: new Map(),
      renderGrid: false,
      renderLinks: true,
      isExporting: false,
      embedsValidationStatus: new Map(),
      elementsPendingErasure: new Set(),
      pendingFlowchartNodes: null,
      theme: appState.theme,
      renderEnvironment,
    },
  };
};

afterEach(() => {
  // `deferredZoomRegens` (renderElement.ts) is module-level, shared across
  // every test in this file -- a test that deliberately leaves elements
  // deferred (to prove deferral happened) must not leak them into the next
  // test's budget/drain-loop assertions. `regenerateDeferredZoomBitmaps`
  // itself reads `performance.now()`, so this must run before the spy below
  // is restored.
  while (regenerateDeferredZoomBitmaps()) {
    // drain fully, ignoring its own per-call budget -- this is cleanup, not
    // something under test here.
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Regression for zoom-render-performance-plan.md §4/Фаза 1: when
 * `shouldCacheIgnoreZoom` flips back to `false` on a scene with many
 * simultaneously-visible elements, regenerating every element's rough.js
 * bitmap in one synchronous pass is the frame that stalls. `renderElement.ts`
 * now budgets that work (`ZOOM_REGEN_BUDGET_MS`) and defers the rest to a
 * `requestAnimationFrame` loop (`staticScene.ts`) instead of doing it all at
 * once.
 */
describe("zoom-triggered bitmap regen budget", () => {
  const rect = (id: string) =>
    ({
      ...newElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      }),
      id,
    } as NonDeletedExcalidrawElement);

  it("defers regeneration past the budget instead of doing it all synchronously", () => {
    // simulate an expensive generateElementCanvas: each regenerated bitmap
    // (one `createCanvas()` call per element, see `generateElementCanvas`)
    // burns enough mocked wall-clock time that only a handful fit under
    // `ZOOM_REGEN_BUDGET_MS`.
    let now = 1_000_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    let regenerations = 0;
    const { env } = makeEnv(() => {
      now += 2; // each bitmap regeneration "costs" 2ms of wall clock
      regenerations++;
    });
    const canvas = makeScene();
    const elements = Array.from({ length: 50 }, (_, i) => rect(`r${i}`));

    // first render at zoom 1, mid-gesture (shouldCacheIgnoreZoom: true) — primes
    // the cache so the *next* render is a pure zoom-triggered regeneration.
    renderStaticScene(
      makeConfig(elements, {
        zoomValue: 1,
        shouldCacheIgnoreZoom: true,
        renderEnvironment: env,
        canvas,
      }),
    );
    expect(regenerations).toBe(elements.length);
    regenerations = 0;

    // gesture ends, shouldCacheIgnoreZoom resets, zoom changed -- this is the
    // pass that would regenerate all 50 bitmaps synchronously pre-fix.
    renderStaticScene(
      makeConfig(elements, {
        zoomValue: 1.5,
        shouldCacheIgnoreZoom: false,
        renderEnvironment: env,
        canvas,
      }),
    );

    // not every element regenerated in this one synchronous pass -- some
    // were deferred instead of forcing the whole batch through at once.
    expect(regenerations).toBeGreaterThan(0);
    expect(regenerations).toBeLessThan(elements.length);

    nowSpy.mockRestore();
  });

  it("drains deferred regenerations over successive animation frames", async () => {
    let now = 2_000_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    let regenerations = 0;
    const { env } = makeEnv(() => {
      now += 2;
      regenerations++;
    });
    const canvas = makeScene();
    const elements = Array.from({ length: 50 }, (_, i) => rect(`r${i}`));

    renderStaticScene(
      makeConfig(elements, {
        zoomValue: 1,
        shouldCacheIgnoreZoom: true,
        renderEnvironment: env,
        canvas,
      }),
    );
    regenerations = 0;

    renderStaticScene(
      makeConfig(elements, {
        zoomValue: 1.5,
        shouldCacheIgnoreZoom: false,
        renderEnvironment: env,
        canvas,
      }),
    );
    const regeneratedSynchronously = regenerations;
    expect(regeneratedSynchronously).toBeLessThan(elements.length);

    // let the rAF drain loop (`scheduleDeferredZoomRegenDrain` in
    // staticScene.ts) run until the deferred queue empties -- it reschedules
    // itself via requestAnimationFrame, so pump that a bounded number of
    // times rather than looping forever if something regresses.
    for (let i = 0; i < elements.length && regenerations < elements.length; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    expect(regenerations).toBe(elements.length);

    nowSpy.mockRestore();
  });
});

/**
 * Regression for Фаза 2 (zoom-render-performance-plan.md §6): even once
 * `shouldCacheIgnoreZoom` genuinely resets, the final sharp pass must not
 * run while too many elements are simultaneously visible — that mass
 * regeneration is the same stall Фаза 1 budgets, just reached a different
 * way (many elements rather than a slow regen step).
 */
describe("visible-element-count sharpen gate (Фаза 2)", () => {
  const rect = (id: string) =>
    ({
      ...newElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      }),
      id,
    } as NonDeletedExcalidrawElement);

  it("keeps bitmaps stale while over the viewport element-count gate", () => {
    let regenerations = 0;
    const { env } = makeEnv(() => {
      regenerations++;
    });
    const canvas = makeScene();
    // LOD_SHARPEN_VISIBLE_ELEMENT_GATE in staticScene.ts is 1200 — comfortably
    // over it without depending on the exact tuned value.
    const elements = Array.from({ length: 1500 }, (_, i) => rect(`r${i}`));

    renderStaticScene(
      makeConfig(elements, {
        zoomValue: 1,
        shouldCacheIgnoreZoom: true,
        renderEnvironment: env,
        canvas,
      }),
    );
    expect(regenerations).toBe(elements.length);
    regenerations = 0;

    // gesture "ends" (shouldCacheIgnoreZoom: false) at a new zoom value --
    // pre-Фаза-2 every element would regenerate here regardless of count.
    renderStaticScene(
      makeConfig(elements, {
        zoomValue: 1.5,
        shouldCacheIgnoreZoom: false,
        renderEnvironment: env,
        canvas,
      }),
    );

    expect(regenerations).toBe(0);
  });
});

/**
 * Regression for Фаза 3 (zoom-render-performance-plan.md §6): an element
 * whose on-screen size (not its data-space size — same element, just more
 * zoomed out) falls under `ROUGHNESS_SIMPLIFY_SCREEN_PX` should be drawn
 * with `roughness: 0`/`fillStyle: "solid"`, cheapening the rough.js
 * generation this budget-free path still has to pay regardless of Фаза 1/2.
 */
describe("small-screen-size roughness simplification (Фаза 3)", () => {
  it("zeroes roughness for a far-zoomed-out element, keeps it at normal zoom", () => {
    const { env } = makeEnv();
    const roughnessCalls: number[] = [];
    const rectangleSpy = vi
      .spyOn(RoughGenerator.prototype, "rectangle")
      .mockImplementation(
        (...args: Parameters<RoughGenerator["rectangle"]>) => {
          roughnessCalls.push(args[4]?.roughness ?? -1);
          // a harmless empty drawable -- rc.draw() iterates `sets`, nothing
          // to draw, no canvas error.
          return {
            shape: "rectangle",
            sets: [],
            options: args[4] ?? {},
          } as ReturnType<RoughGenerator["rectangle"]>;
        },
      );

    const element = {
      ...newElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }),
      id: "simplify-me",
      roughness: 1,
    } as NonDeletedExcalidrawElement;

    // normal zoom: 100 screen px on the larger side, well over the gate.
    renderStaticScene(
      makeConfig([element], {
        zoomValue: 1,
        renderEnvironment: env,
        canvas: makeScene(),
      }),
    );

    // zoomed far out: same element, ~10 screen px now -- under the gate.
    renderStaticScene(
      makeConfig([element], {
        zoomValue: 0.1,
        renderEnvironment: env,
        canvas: makeScene(),
      }),
    );

    expect(roughnessCalls).toEqual([1, 0]);

    rectangleSpy.mockRestore();
  });
});
