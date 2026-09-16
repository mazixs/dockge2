import { fileURLToPath } from "node:url";
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

        // Каталог сборки лежит выше корня Vite, а такой Vite сам не чистит и
        // просит подтверждения явно. Без этого каждая сборка досыпала новый
        // хешированный бандл к прежним: 1833 файла и 284 МБ, и все они попадают
        // в образ, потому что docker/Dockerfile копирует каталог целиком
        emptyOutDir: true,
    },
    css: {
        preprocessorOptions: {
            scss: {
                // Bootstrap 5 внутри написан на @import и старых функциях
                // Sass; исправить это можно только его обновлением, поэтому
                // предупреждения из node_modules гасятся здесь, чтобы в выводе
                // сборки оставались только наши собственные.
                silenceDeprecations: [ "import", "global-builtin", "color-functions", "if-function" ],
            },
        },
    },
    plugins: [
        vue(),
        Components({
            // Абсолютный путь, а не относительный корню Vite: сцена
            // test/visual собирает те же компоненты из другого корня
            dirs: [ fileURLToPath(new URL("src/components", import.meta.url)) ],
            resolvers: [ BootstrapVueNextResolver() ],
            dts: false,
        }),
        compression({
            include: viteCompressionFilter,
            algorithms: [ "gzip", "brotliCompress" ],
        }),
    ],
});
