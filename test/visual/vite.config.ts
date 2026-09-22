import { defineConfig, mergeConfig } from "vite";
import { fileURLToPath } from "node:url";
import base from "../../frontend/vite.config";

/** Separate visual fixture: it is not included in the production build or backend. */
export default mergeConfig(base, defineConfig({
    root: "./test/visual",
    // Keep this scene's dependency graph separate from the real E2E frontend.
    cacheDir: fileURLToPath(new URL("../../node_modules/.vite-visual", import.meta.url)),
    publicDir: "../../frontend/public",
    server: { host: "127.0.0.1",
        port: 5090,
        strictPort: true },
}));
