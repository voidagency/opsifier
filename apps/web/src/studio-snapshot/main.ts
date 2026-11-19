import { capture, fromFile, type SnapshotRequest } from "./snapshot";

/** What the inspector calls, once it has loaded this script from the panel. */
declare global {
  interface Window {
    __opsifierStudioSnapshot?: {
      capture(request: SnapshotRequest): Promise<string>;
      fromFile(file: Blob): Promise<string>;
    };
  }
}

window.__opsifierStudioSnapshot = { capture, fromFile };
