/**
 * Main-thread side of Фаза 6 (zoom-render-performance-plan.md §6). Fires one
 * batched request per deferred-regen drain tick to pre-warm `ShapeCache`
 * with rough.js shapes computed off the main thread, so that by the time
 * `regenerateDeferredZoomBitmaps` (renderElement.ts) actually draws a
 * deferred element, `ShapeCache.generateElementShape` is a cache hit
 * instead of having to run rough.js generation synchronously.
 *
 * Purely additive prefetch: if workers are unavailable or the request
 * fails, callers fall back to exactly what they do today (synchronous
 * generation inline) — this module never changes behavior, only latency.
 *
 * Deliberately self-contained (no `@excalidraw/excalidraw` import): that
 * package already depends on `@excalidraw/element`, and `@excalidraw/element`
 * has no runtime dependency on `@excalidraw/excalidraw` -- `workers.ts`'s
 * `WorkerPool` there is not reusable from here without creating a package
 * cycle (and silently inlining the entire excalidraw package into this
 * one's bundle, since only `@excalidraw/common`/`math`/`fractional-indexing`
 * are declared/external for this package's build). The pool below is a
 * small single-purpose copy of that same lazy/idle-worker/fallback shape,
 * scoped to this one use case.
 */
import { promiseTry } from "@excalidraw/common";

import type {
  AppState,
  EmbedsValidationStatus,
} from "@excalidraw/excalidraw/types";

import { ShapeCache } from "./shape";

import type {
  ShapeWorkerItem,
  ShapeWorkerRequest,
  ShapeWorkerResponse,
} from "./shapeWorker.chunk";
import type { ExcalidrawElement, ExcalidrawSelectionElement } from "./types";

let shouldUseWorkers = typeof Worker !== "undefined";

let shapeWorkerChunk: Promise<typeof import("./shapeWorker.chunk")> | null =
  null;

const lazyLoadShapeWorkerChunk = async () => {
  if (!shapeWorkerChunk) {
    // dynamic import forces this to be a separate chunk in any bundler that
    // does code-splitting (the consuming app's, not this package's own
    // single-file esbuild build) -- same pattern as subset-main.ts.
    shapeWorkerChunk = import("./shapeWorker.chunk");
  }
  return shapeWorkerChunk;
};

let worker: Worker | null = null;
let nextCallbackId = 0;
const pendingByCallbackId = new Map<
  number,
  { resolve: (r: ShapeWorkerResponse) => void; reject: (e: unknown) => void }
>();

/**
 * Lazily creates the single long-lived worker this module uses. Unlike
 * `WorkerPool` (excalidraw/workers.ts), there's no idle-pool/TTL here: one
 * worker, reused for every drain-tick batch, torn down only on error.
 */
const getOrCreateWorker = async (): Promise<Worker> => {
  if (worker) {
    return worker;
  }

  const { WorkerUrl } = await lazyLoadShapeWorkerChunk();
  if (!WorkerUrl) {
    throw new Error("Shape worker URL is not defined");
  }
  if (!import.meta.url || WorkerUrl.toString() === import.meta.url) {
    // the worker code ended up in the same chunk as this file (e.g. this
    // package's own dev build, which bundles everything into one file) --
    // nothing to actually offload to, so don't pretend otherwise.
    throw new Error("Shape worker is in the main chunk");
  }

  const instance = new Worker(WorkerUrl, { type: "module" });
  instance.onmessage = (e: {
    data: ShapeWorkerResponse & { callbackId: number };
  }) => {
    const pending = pendingByCallbackId.get(e.data.callbackId);
    pendingByCallbackId.delete(e.data.callbackId);
    pending?.resolve(e.data);
  };
  instance.onerror = (e: ErrorEvent) => {
    for (const pending of pendingByCallbackId.values()) {
      pending.reject(e);
    }
    pendingByCallbackId.clear();
    instance.terminate();
    worker = null;
  };

  worker = instance;
  return instance;
};

const postToWorker = async (
  request: ShapeWorkerRequest,
): Promise<ShapeWorkerResponse> => {
  const instance = await getOrCreateWorker();
  const callbackId = nextCallbackId++;

  return new Promise((resolve, reject) => {
    pendingByCallbackId.set(callbackId, { resolve, reject });
    instance.postMessage({ ...request, callbackId });
  });
};

export type PrewarmShapeRequest = {
  element: Exclude<ExcalidrawElement, ExcalidrawSelectionElement>;
  renderConfig: {
    isExporting: boolean;
    canvasBackgroundColor: AppState["viewBackgroundColor"];
    embedsValidationStatus: EmbedsValidationStatus;
    theme: AppState["theme"];
  };
};

/**
 * Fire-and-forget: computes shapes for `requests` off the main thread and
 * writes results straight into `ShapeCache` via `setPrecomputed` (which
 * itself no-ops if the element changed or is already cached). Never
 * throws — any failure (unsupported workers, worker error) is swallowed,
 * leaving the elements to be generated synchronously as they are today.
 */
export const prewarmShapesInWorker = (
  requests: PrewarmShapeRequest[],
): void => {
  if (!shouldUseWorkers || requests.length === 0) {
    return;
  }

  const items: ShapeWorkerItem[] = requests.map(
    ({ element, renderConfig }) => ({
      elementId: element.id,
      elementVersion: element.version,
      element,
      renderConfig: {
        isExporting: renderConfig.isExporting,
        canvasBackgroundColor: renderConfig.canvasBackgroundColor,
        embedsValidationStatusEntries: Array.from(
          renderConfig.embedsValidationStatus.entries(),
        ),
        theme: renderConfig.theme,
      },
    }),
  );

  const themeByElementId = new Map(
    requests.map((r) => [r.element.id, r.renderConfig.theme]),
  );
  const elementById = new Map(requests.map((r) => [r.element.id, r.element]));

  promiseTry(async () => {
    const response = await postToWorker({ items });

    for (const result of response.results) {
      if ("error" in result) {
        continue;
      }
      const element = elementById.get(result.elementId);
      const theme = themeByElementId.get(result.elementId);
      if (!element || theme === undefined) {
        continue;
      }
      ShapeCache.setPrecomputed(
        element,
        result.elementVersion,
        result.shape,
        theme,
      );
    }
  }).catch((e) => {
    // don't keep trying workers for the rest of the session if they're
    // failing -- matches the fallback policy `subset-main.ts` uses for its
    // own (unrelated) worker.
    shouldUseWorkers = false;
    // eslint-disable-next-line no-console
    console.debug(
      "Shape-generation worker prewarm failed, falling back to synchronous generation.",
      e,
    );
  });
};
