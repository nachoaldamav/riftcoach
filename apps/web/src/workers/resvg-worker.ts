/// <reference lib="webworker" />
// Dedicated worker to render SVG to PNG using Resvg WASM off the main thread
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url';

// Use the global `self` provided by the webworker lib reference

let wasmInitPromise: Promise<void> | null = null;
let wasmInitialized = false;

async function ensureResvgWasmInitialized(): Promise<void> {
  if (wasmInitialized) return;
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      try {
        const wasmBinary = await fetch(resvgWasmUrl).then((r) => r.arrayBuffer());
        await initWasm(wasmBinary);
        wasmInitialized = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Already initialized')) {
          wasmInitialized = true;
          return;
        }
        wasmInitPromise = null;
        throw e;
      }
    })();
  }
  return wasmInitPromise;
}

interface WorkerRequest {
  svg: string;
  scale?: number;
}

interface WorkerResponseOk {
  ok: true;
  png: ArrayBuffer;
}

interface WorkerResponseErr {
  ok: false;
  error: string;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { svg, scale = 2 } = event.data || {};
  try {
    if (!svg || typeof svg !== 'string') throw new Error('Invalid SVG payload');
    await ensureResvgWasmInitialized();
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: 'zoom',
        value: scale,
      },
    });
    const pngData = resvg.render().asPng(); // Uint8Array
    // Construct a fresh ArrayBuffer to avoid SharedArrayBuffer union issues
    const ab = new ArrayBuffer(pngData.byteLength);
    new Uint8Array(ab).set(pngData);
    const response: WorkerResponseOk = { ok: true, png: ab };
    // Transfer the buffer to prevent copying
    self.postMessage(response, [ab]);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const response: WorkerResponseErr = { ok: false, error };
    self.postMessage(response);
  }
};