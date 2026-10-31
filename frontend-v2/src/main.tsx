/**
 * Renderer entry.
 *
 * Order matters here. The bridge is installed *before* the host is told the
 * renderer is ready, because `signalRendererReady()` goes out over
 * `window.localAgent.showMainWindow` — which does not exist until
 * `installBridge()` has run. Reversing the two silently never shows the
 * window until the host's own 5 s fallback fires.
 */

import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { installBridge, signalRendererReady } from "./lib/bridge";
import { ToastProvider, TooltipProvider } from "./components/ui";
import "./styles/global.css";

function Root() {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await installBridge();
      if (cancelled) {
        return;
      }
      // Paint has happened by the time an effect runs, so the window can be
      // shown now without the user seeing an empty frame.
      await signalRendererReady();
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // TooltipProvider has to wrap the app exactly once so every tooltip shares
  // one open/close delay — without it, moving between two adjacent controls
  // re-waits the full delay each time.
  return (
    <ToastProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ToastProvider>
  );
}

const container = document.getElementById("root");
if (!container) {
  // Nothing can be rendered without a mount point, and a silent no-op here
  // looks identical to a hung backend. Fail loudly in the console instead.
  throw new Error("Mount point #root is missing from index.html.");
}

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
