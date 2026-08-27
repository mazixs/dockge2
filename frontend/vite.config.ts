import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Components from "unplugin-vue-components/vite";
import { BootstrapVueNextResolver } from "unplugin-vue-components/resolvers";
import { compression } from "vite-plugin-compression2";
import "vue";

const viteCompressionFilter = /\.(js|mjs|json|css|html|svg)$/i;

// https://vitejs.dev/config/
export default defineConfig({
    server: {
        port: 5000,
    },
    define: {
        "FRONTEND_VERSION": JSON.stringify(process.env.npm_package_version),
    },
    root: "./frontend",
    build: {
        outDir: "../frontend-dist",
    },
    css: {
        preprocessorOptions: {
            scss: {
                // Bootstrap 5 внутри написан на @import и старых функциях
                // Sass; исправить это можно только его обновлением, поэтому
                // предупреждения из node_modules гасятся здесь, чтобы в выводе
                // сборки оставались только наши собственные.
                silenceDeprecations: [ "import", "global-builtin", "color-functions", "if-function", "mixed-decls" ],
            },
        },
    },
    plugins: [
        vue(),
        Components({
            resolvers: [ BootstrapVueNextResolver() ],
            dts: false,
        }),
        compression({
            include: viteCompressionFilter,
            algorithms: [ "gzip", "brotliCompress" ],
        }),
    ],
});
