import { defineConfig, mergeConfig } from "vite";
import base from "../../frontend/vite.config";

/** Separate visual fixture: it is not included in the production build or backend. */
export default mergeConfig(base, defineConfig({
    root: "./test/visual",
    publicDir: "../../frontend/public",
    server: { host: "127.0.0.1",
        port: 5090,
        strictPort: true },
}));
