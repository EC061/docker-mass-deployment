// Must be imported before "next". Next reads globalThis.AsyncLocalStorage at module-load time (in
// work-async-storage-instance.js), but its own polyfill (node-environment-baseline) only runs later
// inside app.prepare() — so a custom server that imports `next` first crashes. Mirror the baseline
// here so the global is in place before any next module loads.
import { AsyncLocalStorage } from "node:async_hooks";

const g = globalThis as Record<string, unknown>;
if (typeof g.AsyncLocalStorage !== "function") {
  g.AsyncLocalStorage = AsyncLocalStorage;
}
