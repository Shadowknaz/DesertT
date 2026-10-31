import { defineConfig } from 'vite';

// Vite-конфиг: сборка без фреймворка, точка входа — корневой index.html.
// three и @dimforge/rapier3d-compat приходят из node_modules вместо CDN-importmap.
export default defineConfig({
    server: {
        port: 8000,
    },
    build: {
        // main.ts использует top-level await (RAPIER.init) — нужен es2022+
        target: 'es2022',
        // three + rapier-wasm один бандл разумно держать крупным
        chunkSizeWarningLimit: 1500,
    },
});

