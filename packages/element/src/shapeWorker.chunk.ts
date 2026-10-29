/**
 * Worker entry for Фаза 6 (zoom-render-performance-plan.md §6): offloads
 * only the CPU-bound rough.js geometry generation
 * (`generateElementShapePure`, see `shape.ts`) to a Worker. Everything else
 * — the canvas, `rc.draw()`, bitmap caching, pan-reuse, zoom-regen budget
 * scheduling, fonts, images — stays on the main thread, unchanged.
 *
 * One message = one batch (the whole set of elements a deferred-regen drain
 * tick wants pre-warmed), not one message per element — `WorkerPool` spawns
 * a worker per in-flight `postMessage` with no cap, so a per-element
 * protocol would spawn one worker per deferred element on a big zoom-out.
 *
 * Due to this export (and the related dynamic import in
 * `shapeWorkerClient.ts`), this file is bundled as its own chunk
 * automatically, without special plugin config. `import.meta.url` is
 * undefined in Node.
 */
import { RoughGenerator } from "roughjs/bin/generator";

import type { ElementShape } from "@excalidraw/excalidraw/scene/types";

import type { AppState } from "@excalidraw/excalidraw/types";

import { generateElementShapePure } from "./shape";

import type { ExcalidrawElement, ExcalidrawSelectionElement } from "./types";

export const WorkerUrl: URL | undefined = import.meta.url
  ? new URL(import.meta.url)
  : undefined;

export type ShapeWorkerItemRenderConfig = {
  isExporting: boolean;
  canvasBackgroundColor: string;
  embedsValidationStatusEntries: Array<[string, boolean]>;
  theme?: AppState["theme"];
};

export type ShapeWorkerItem = {
  elementId: string;
  elementVersion: number;
  element: Exclude<ExcalidrawElement, ExcalidrawSelectionElement>;
  renderConfig: ShapeWorkerItemRenderConfig;
};

export type ShapeWorkerRequest = {
  items: ShapeWorkerItem[];
};

export type ShapeWorkerResultItem =
  | { elementId: string; elementVersion: number; shape: ElementShape }
  | { elementId: string; elementVersion: number; error: string };

export type ShapeWorkerResponse = {
  results: ShapeWorkerResultItem[];
};

type IncomingMessage = ShapeWorkerRequest & { callbackId: number };
type OutgoingMessage = ShapeWorkerResponse & { callbackId: number };

const computeOne = (
  generator: RoughGenerator,
  item: ShapeWorkerItem,
): ShapeWorkerResultItem => {
  try {
    const shape = generateElementShapePure(item.element, generator, {
      isExporting: item.renderConfig.isExporting,
      canvasBackgroundColor: item.renderConfig.canvasBackgroundColor,
      embedsValidationStatus: new Map(
        item.renderConfig.embedsValidationStatusEntries,
      ),
      theme: item.renderConfig.theme,
    });
    return {
      elementId: item.elementId,
      elementVersion: item.elementVersion,
      shape,
    };
  } catch (error) {
    return {
      elementId: item.elementId,
      elementVersion: item.elementVersion,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

// run only in the worker context
if (typeof window === "undefined" && typeof self !== "undefined") {
  const generator = new RoughGenerator();

  self.onmessage = (e: { data: IncomingMessage }) => {
    const results = e.data.items.map((item) => computeOne(generator, item));
    const response: OutgoingMessage = {
      results,
      callbackId: e.data.callbackId,
    };
    self.postMessage(response);
  };
}
