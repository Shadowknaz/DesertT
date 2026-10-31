// Процедурные пиксельные текстуры: песок дюн и панели брони меха.
// Рисуются в canvas и отдаются в three как CanvasTexture с NearestFilter.
import * as THREE from 'three';
import { hash2, valueNoise } from './noise.ts';

export function createSandTexture(): THREE.CanvasTexture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context for sand texture');
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const grain = (hash2(x * 1.3, y * 1.3) - 0.5) * 34;
            const wave = Math.sin((x + y * 0.4) * 0.45) * 10;
            const sparkle = hash2(x * 5.7, y * 5.7) > 0.96 ? 35 : 0;

            data[i]     = Math.min(255, Math.max(0, 224 + grain + wave + sparkle));
            data[i + 1] = Math.min(255, Math.max(0, 172 + grain + wave + sparkle * 0.8));
            data[i + 2] = Math.min(255, Math.max(0, 112 + grain + wave + sparkle * 0.5));
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(14, 14);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
}

// Панель брони: темная кромка, заклепки, ржавчина, потертости и пыльный налет снизу.
export function createMechTexture(baseR: number, baseG: number, baseB: number): THREE.CanvasTexture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context for mech texture');
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const border = (x < 3 || x > size - 4 || y < 3 || y > size - 4) ? -32 : 0;
            const rivet = ((x === 6 || x === size - 7) && (y === 6 || y === size - 7)) ? 35 : 0;
            const rust = (valueNoise(x * 0.25, y * 0.25) - 0.4) * 40;
            const wear = (hash2(x, y) - 0.5) * 20;

            // Пыльный налет снизу деталей
            const dust = (y / size) * 24;

            data[i]     = Math.min(255, Math.max(0, baseR + border + rivet + rust + wear + dust * 1.1));
            data[i + 1] = Math.min(255, Math.max(0, baseG + border + rivet + rust * 0.6 + wear + dust * 0.85));
            data[i + 2] = Math.min(255, Math.max(0, baseB + border + rivet + wear + dust * 0.5));
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
}

