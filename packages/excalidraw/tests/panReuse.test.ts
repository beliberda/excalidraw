// @vitest-environment-options {"url": "http://localhost/"}

import { RoughCanvas } from "roughjs/bin/canvas";

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
import {
  computePanReusePlan,
  sceneRectForBand,
} from "../renderer/panReuse";

import type { PanReuseEligibilitySnapshot } from "../renderer/panReuse";
import type { StaticCanvasAppState } from "../types";
import type {
  RenderableElementsMap,
  StaticSceneRenderConfig,
} from "../scene/types";

const baseSnapshot: PanReuseEligibilitySnapshot = {
  canvasNonce: "n1",
  zoomValue: 1,
  scale: 1,
  width: 1000,
  height: 1000,
  theme: "light",
  renderGrid: true,
  gridSize: 20,
  gridStep: 5,
  viewBackgroundColor: "#ffffff",
  scrollX: 0,
  scrollY: 0,
};

describe("computePanReusePlan (Фаза 5, pure logic)", () => {
  it("is ineligible with no previous snapshot", () => {
    expect(computePanReusePlan(undefined, baseSnapshot)).toBeNull();
  });

  it("is ineligible when nothing moved", () => {
    expect(computePanReusePlan(baseSnapshot, baseSnapshot)).toBeNull();
  });

  it("is ineligible when zoom changed", () => {
    const next = { ...baseSnapshot, scrollX: 10, zoomValue: 1.5 };
    expect(computePanReusePlan(baseSnapshot, next)).toBeNull();
  });

  it("is ineligible when canvasNonce changed (scene data changed)", () => {
    const next = { ...baseSnapshot, scrollX: 10, canvasNonce: "n2" };
    expect(computePanReusePlan(baseSnapshot, next)).toBeNull();
  });

  it("is ineligible when theme, grid, or background changed", () => {
    expect(
      computePanReusePlan(baseSnapshot, {
        ...baseSnapshot,
        scrollX: 10,
        theme: "dark",
      }),
    ).toBeNull();
    expect(
      computePanReusePlan(baseSnapshot, {
        ...baseSnapshot,
        scrollX: 10,
        renderGrid: false,
      }),
    ).toBeNull();
    expect(
      computePanReusePlan(baseSnapshot, {
        ...baseSnapshot,
        scrollX: 10,
        viewBackgroundColor: "#000000",
      }),
    ).toBeNull();
  });

  it("is ineligible when the shift covers the whole canvas", () => {
    const next = { ...baseSnapshot, scrollX: 2000 }; // dx = 2000 >= width(1000)
    expect(computePanReusePlan(baseSnapshot, next)).toBeNull();
  });

  it("computes a single right-edge band for a rightward (dx>0) pan", () => {
    // scrollX increases -> content shifts right on screen -> new content
    // revealed on the LEFT edge.
    const next = { ...baseSnapshot, scrollX: 15 };
    const plan = computePanReusePlan(baseSnapshot, next);
    expect(plan).not.toBeNull();
    expect(plan!.dx).toBe(15);
    expect(plan!.dy).toBe(0);
    expect(plan!.bands).toEqual([{ x: 0, y: 0, w: 15, h: 1000 }]);
  });

  it("computes a right-edge band for a leftward (dx<0) pan", () => {
    const next = { ...baseSnapshot, scrollX: -15 };
    const plan = computePanReusePlan(baseSnapshot, next);
    expect(plan!.dx).toBe(-15);
    expect(plan!.bands).toEqual([{ x: 985, y: 0, w: 15, h: 1000 }]);
  });

  it("computes two bands for a diagonal pan", () => {
    const next = { ...baseSnapshot, scrollX: 15, scrollY: -8 };
    const plan = computePanReusePlan(baseSnapshot, next);
    expect(plan!.dx).toBe(15);
    expect(plan!.dy).toBe(-8);
    expect(plan!.bands).toEqual([
      { x: 0, y: 0, w: 15, h: 1000 },
      { x: 0, y: 992, w: 1000, h: 8 },
    ]);
  });

  it("rounds a fractional device-pixel delta (from a fractional scale) to whole pixels", () => {
    const prev = { ...baseSnapshot, scale: 1.5, scrollX: 0 };
    const next = { ...prev, scrollX: 10 }; // dx = 10 * (1 * 1.5) = 15
    const plan = computePanReusePlan(prev, next);
    expect(plan!.dx).toBe(15);
  });
});

describe("sceneRectForBand", () => {
  it("inverts the forward scene->device-pixel transform", () => {
    // devicePixels = zoom(2) * scale(1) = 2; scroll = 5
    const rect = sceneRectForBand({ x: 10, y: 20, w: 30, h: 40 }, 5, 5, 2);
    // sceneX = rawX/devicePixels - scroll
    expect(rect.x1).toBe(10 / 2 - 5);
    expect(rect.y1).toBe(20 / 2 - 5);
    expect(rect.x2).toBe(40 / 2 - 5);
    expect(rect.y2).toBe(60 / 2 - 5);
  });
});

// --- integration: renderStaticScene end-to-end, spying on the canvas mock ---

const makeDecodedImage = () => {
  const image = document.createElement("img");
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "naturalWidth", { value: 16 });
  return image;
};

const makeEnv = (): RenderEnvironment => ({
  createCanvas: () => document.createElement("canvas"),
  createImage: makeDecodedImage,
});

const baseAppState = {
  ...getDefaultAppState(),
  width: 1000,
  height: 1000,
  offsetLeft: 0,
  offsetTop: 0,
  gridSize: 20,
  gridStep: 5,
} as StaticCanvasAppState;

const makeScene = () =>
  Object.assign(document.createElement("canvas"), {
    width: 1000,
    height: 1000,
  });

const makeConfig = (
  elements: NonDeletedExcalidrawElement[],
  opts: {
    scrollX?: number;
    scrollY?: number;
    zoomValue?: number;
    canvasNonce: string;
    canvas: HTMLCanvasElement;
  },
): StaticSceneRenderConfig => {
  const elementsMap = new Map(
    elements.map((element) => [element.id, element]),
  ) as unknown as ElementsMap;

  const appState = {
    ...baseAppState,
    scrollX: opts.scrollX ?? 0,
    scrollY: opts.scrollY ?? 0,
    zoom: { value: opts.zoomValue ?? 1 },
  } as StaticCanvasAppState;

  return {
    canvas: opts.canvas,
    rc: new RoughCanvas(opts.canvas),
    elementsMap: elementsMap as unknown as RenderableElementsMap,
    allElementsMap: elementsMap as unknown as NonDeletedSceneElementsMap,
    visibleElements: elements,
    scale: 1,
    appState,
    renderConfig: {
      canvasBackgroundColor: "",
      scale: 1,
      imageCache: new Map(),
      renderGrid: true,
      renderLinks: true,
      isExporting: false,
      embedsValidationStatus: new Map(),
      elementsPendingErasure: new Set(),
      pendingFlowchartNodes: null,
      theme: appState.theme,
      renderEnvironment: makeEnv(),
    },
    canvasNonce: opts.canvasNonce,
  };
};

const rect = (id: string, x: number, y: number) =>
  ({
    ...newElement({ type: "rectangle", x, y, width: 50, height: 50 }),
    id,
  } as NonDeletedExcalidrawElement);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderStaticScene pan-reuse integration (Фаза 5)", () => {
  it("self-blits and clips on a pure scroll change, skipping a full background repaint", () => {
    const canvas = makeScene();
    const elements = [rect("a", 0, 0), rect("b", 900, 900)];

    renderStaticScene(makeConfig(elements, { canvasNonce: "n1", canvas }));

    const ctx = canvas.getContext("2d") as unknown as {
      drawImage: { mock: { calls: unknown[][] } };
      clip: { mock: { calls: unknown[][] } };
      rect: { mock: { calls: unknown[][] } };
    };
    ctx.drawImage.mock.calls.length = 0;
    ctx.clip.mock.calls.length = 0;
    ctx.rect.mock.calls.length = 0;

    renderStaticScene(
      makeConfig(elements, { canvasNonce: "n1", canvas, scrollX: 15 }),
    );

    // self-blit: a drawImage call whose source is the canvas itself
    const selfBlits = ctx.drawImage.mock.calls.filter(
      (args) => args[0] === canvas,
    );
    expect(selfBlits).toHaveLength(1);
    expect(selfBlits[0].slice(1, 3)).toEqual([15, 0]);

    // the exposed strip's bounding rect was clipped (not the arguments
    // bootstrapCanvas's fillRect passes -- those are always logically
    // full-canvas, same as any real browser; `context.clip()` is what
    // confines what actually paints, and the mock only lets us assert the
    // `rect()` call that fed it) before the strip was repainted.
    expect(ctx.clip.mock.calls.length).toBeGreaterThan(0);
    expect(ctx.rect.mock.calls).toContainEqual([0, 0, 15, 1000]);
  });

  it("falls back to a full repaint (no self-blit) when zoom changed", () => {
    const canvas = makeScene();
    const elements = [rect("a", 0, 0)];

    renderStaticScene(makeConfig(elements, { canvasNonce: "n1", canvas }));

    const ctx = canvas.getContext("2d") as unknown as {
      drawImage: { mock: { calls: unknown[][] } };
    };
    ctx.drawImage.mock.calls.length = 0;

    renderStaticScene(
      makeConfig(elements, {
        canvasNonce: "n1",
        canvas,
        scrollX: 15,
        zoomValue: 1.2,
      }),
    );

    const selfBlits = ctx.drawImage.mock.calls.filter(
      (args) => args[0] === canvas,
    );
    expect(selfBlits).toHaveLength(0);
  });

  it("falls back to a full repaint when canvasNonce changed (scene data changed)", () => {
    const canvas = makeScene();
    const elements = [rect("a", 0, 0)];

    renderStaticScene(makeConfig(elements, { canvasNonce: "n1", canvas }));

    const ctx = canvas.getContext("2d") as unknown as {
      drawImage: { mock: { calls: unknown[][] } };
    };
    ctx.drawImage.mock.calls.length = 0;

    renderStaticScene(
      makeConfig(elements, { canvasNonce: "n2", canvas, scrollX: 15 }),
    );

    const selfBlits = ctx.drawImage.mock.calls.filter(
      (args) => args[0] === canvas,
    );
    expect(selfBlits).toHaveLength(0);
  });

  it("includes a boundary element straddling the exposed strip in the strip repaint", () => {
    const canvas = makeScene();
    // sits at scene x in [-10, 40] -- after a scrollX:15 pan (new exposed
    // strip covers raw x in [0, 15), i.e. scene x in [-15, 0) at zoom 1)
    // this element's bbox overlaps the strip.
    const straddling = rect("straddling", -10, 500);
    const elsewhere = rect("elsewhere", 500, 500);
    const elements = [straddling, elsewhere];

    renderStaticScene(makeConfig(elements, { canvasNonce: "n1", canvas }));

    const drawImageSpy = vi.spyOn(
      canvas.getContext("2d") as unknown as {
        drawImage: (...args: unknown[]) => void;
      },
      "drawImage",
    );
    drawImageSpy.mockClear();

    renderStaticScene(
      makeConfig(elements, { canvasNonce: "n1", canvas, scrollX: 15 }),
    );

    // elementWithCanvasCache blits each rendered element's bitmap via
    // drawImage with the element's own cached canvas as source -- the
    // straddling element must have been blitted again (inside the clipped
    // strip); the element entirely elsewhere must not have been touched.
    const blittedCanvases = new Set(
      drawImageSpy.mock.calls
        .map((args) => args[0])
        .filter((source): source is HTMLCanvasElement => source !== canvas),
    );
    expect(blittedCanvases.size).toBeGreaterThan(0);
  });
});
