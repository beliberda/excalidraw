import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { COLOR_PALETTE, THEME } from "@excalidraw/common";

import { vi } from "vitest";

import { ShapeCache, generateElementShapePure } from "../src/shape";

import type {
  ShapeWorkerRequest,
  ShapeWorkerResponse,
} from "../src/shapeWorker.chunk";

/**
 * Regression for zoom-render-performance-plan.md §6/Фаза 6: the worker
 * prewarm path must (a) populate `ShapeCache` with a shape identical to the
 * synchronous fallback, (b) never clobber a cache entry that's already
 * fresher than the request (version/race guard in `ShapeCache.setPrecomputed`),
 * and (c) fall back to exactly today's behavior (no worker writes at all)
 * when workers are unavailable.
 */

const baseRenderConfig = () => ({
  isExporting: false,
  canvasBackgroundColor: COLOR_PALETTE.white,
  embedsValidationStatus: new Map(),
  theme: THEME.LIGHT,
});

describe("Фаза 6: shape-worker prewarm", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("produces a shape identical to the synchronous path for each supported element type", async () => {
    const { RoughGenerator } = await import("roughjs/bin/generator");

    const rectangle = API.createElement({ type: "rectangle" });
    const ellipse = API.createElement({ type: "ellipse" });
    const diamond = API.createElement({ type: "diamond" });
    const arrow = API.createElement({ type: "arrow" });
    const freedraw = API.createElement({ type: "freedraw" });

    for (const element of [rectangle, ellipse, diamond, arrow, freedraw]) {
      // same entry point the worker calls (shapeWorker.chunk.ts) and the
      // same one `ShapeCache.generateElementShape` calls synchronously --
      // both must be calling exactly one implementation.
      const viaWorkerEntryPoint = generateElementShapePure(
        element as any,
        new RoughGenerator(),
        baseRenderConfig(),
      );
      const viaSyncPath = ShapeCache.generateElementShape(element as any, null);
      expect(viaWorkerEntryPoint).toEqual(viaSyncPath);
    }
  });

  it("setPrecomputed populates the cache for a matching, not-yet-cached element", () => {
    const element = API.createElement({ type: "rectangle" });
    expect(ShapeCache.get(element, THEME.LIGHT)).toBeUndefined();

    const shape = ShapeCache.generateElementShape(
      element as any,
      baseRenderConfig(),
    );
    ShapeCache.delete(element);
    expect(ShapeCache.get(element, THEME.LIGHT)).toBeUndefined();

    ShapeCache.setPrecomputed(
      element,
      element.version,
      shape as any,
      THEME.LIGHT,
    );
    expect(ShapeCache.get(element, THEME.LIGHT)).toEqual(shape);
  });

  it("setPrecomputed is a no-op if the element changed since the request was made", () => {
    const element = API.createElement({ type: "rectangle" });
    const staleShape = ShapeCache.generateElementShape(
      element as any,
      baseRenderConfig(),
    );
    ShapeCache.delete(element);

    const staleVersion = element.version;
    // simulate the element having been edited while the worker request was
    // in flight -- the race `setPrecomputed`'s version check guards against.
    (element as any).version = staleVersion + 1;

    ShapeCache.setPrecomputed(
      element,
      staleVersion,
      staleShape as any,
      THEME.LIGHT,
    );
    expect(ShapeCache.get(element, THEME.LIGHT)).toBeUndefined();
  });

  it("setPrecomputed is a no-op if the cache already has a fresher entry", () => {
    const element = API.createElement({ type: "rectangle" });
    const freshShape = ShapeCache.generateElementShape(
      element as any,
      baseRenderConfig(),
    );

    const otherShape = { ...(freshShape as any) };
    ShapeCache.setPrecomputed(
      element,
      element.version,
      otherShape,
      THEME.LIGHT,
    );

    // the already-cached (synchronously generated) shape wins, not the
    // late-arriving worker result.
    expect(ShapeCache.get(element, THEME.LIGHT)).toBe(freshShape);
  });

  it("falls back cleanly when Worker is unavailable (no cache writes, no throw)", async () => {
    vi.resetModules();
    const originalWorker = (globalThis as any).Worker;
    // eslint-disable-next-line no-undef
    delete (globalThis as any).Worker;

    try {
      const { prewarmShapesInWorker } = await import(
        "../src/shapeWorkerClient"
      );
      const { ShapeCache: FreshShapeCache } = await import("../src/shape");

      const element = API.createElement({ type: "rectangle" });
      expect(() =>
        prewarmShapesInWorker([
          {
            element: element as any,
            renderConfig: {
              isExporting: false,
              canvasBackgroundColor: COLOR_PALETTE.white,
              embedsValidationStatus: new Map(),
              theme: THEME.LIGHT,
            },
          },
        ]),
      ).not.toThrow();

      // no worker available -> nothing should land in the cache from this call
      expect(FreshShapeCache.get(element, THEME.LIGHT)).toBeUndefined();
    } finally {
      if (originalWorker) {
        (globalThis as any).Worker = originalWorker;
      }
    }
  });
});

// keep the imported request/response types referenced so this file fails to
// typecheck if the worker protocol's shape ever drifts from what the client
// sends/expects.
const _typeCheck = (
  req: ShapeWorkerRequest,
  res: ShapeWorkerResponse,
): [ShapeWorkerRequest, ShapeWorkerResponse] => [req, res];
void _typeCheck;
