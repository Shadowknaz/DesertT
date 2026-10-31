import { defineConfig } from 'vite';

// Vite-конфиг: сборка без фреймворка, точка входа — корневой index.html.
// three и @dimforge/rapier3d-compat приходят из node_modules вместо CDN-importmap.
export default defineConfig({
    server: {
        port: 3000,
        host: '0.0.0.0',
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    preview: {
        allowedHosts: true,
    },
    build: {
        // main.ts использует top-level await (RAPIER.init) — нужен es2022+
        target: 'es2022',
        // three + rapier-wasm один бандл разумно держать крупным
        chunkSizeWarningLimit: 1500,
    },
});

