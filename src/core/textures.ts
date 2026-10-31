// Процедурные пиксельные текстуры: песок дюн и панели брони меха.
// Рисуются в canvas и отдаются в three как CanvasTexture с NearestFilter.
import * as THREE from 'three';
import { hash2, valueNoise } from './noise.ts';

// Бесшовный тороидальный шум для процедурного полотна песка
function seamlessNoise(x: number, y: number, size: number, freq: number): number {
    const nx = (x / size) * Math.PI * 2;
    const ny = (y / size) * Math.PI * 2;
    const cosX = Math.cos(nx) * freq;
    const sinX = Math.sin(nx) * freq;
    const cosY = Math.cos(ny) * freq;
    const sinY = Math.sin(ny) * freq;
    return valueNoise(cosX + 10.0, sinX + cosY + 10.0) * 0.5 +
           valueNoise(sinY + 20.0, cosY + sinX + 20.0) * 0.5;
}

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

            // Крупномасштабные минеральные пятна (охра, глина, кварцевый песок)
            const macro = (seamlessNoise(x, y, size, 1.4) - 0.5) * 22;

            // Ветровая рябь с небольшим органичным возмущением
            const waveAngle = 0.35;
            const waveCoord = (x * Math.cos(waveAngle) + y * Math.sin(waveAngle)) * 0.22;
            const waveDistort = (seamlessNoise(x, y, size, 2.2) - 0.5) * 3.5;
            const wave = Math.sin(waveCoord + waveDistort) * 6;

            // Высокочастотная зернистость отдельных песчинок
            const grain = (hash2(x * 1.73, y * 2.41) - 0.5) * 26;

            // Редкие мерцающие кристаллики кремния
            const sparkle = hash2(x * 5.7, y * 5.7) > 0.965 ? 32 : 0;

            const r = 224 + macro + wave + grain + sparkle;
            const g = 172 + macro * 0.85 + wave * 0.8 + grain + sparkle * 0.8;
            const b = 112 + macro * 0.6 + wave * 0.6 + grain + sparkle * 0.5;

            data[i]     = Math.min(255, Math.max(0, r));
            data[i + 1] = Math.min(255, Math.max(0, g));
            data[i + 2] = Math.min(255, Math.max(0, b));
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 8);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
}

// Низкоамплитудная карта микрорельефа: она не меняет цвет песка, но дает
// направленный световой break-up на склонах, включая дальние участки сетки.
export function createSandDetailTexture(): THREE.CanvasTexture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context for sand detail texture');
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const macro = seamlessNoise(x, y, size, 1.8);
            const waveCoord = (x * 0.22 + y * 0.08) + Math.sin(y * 0.07) * 0.9;
            const ripple = 0.5 + 0.5 * Math.sin(waveCoord + macro * 2.4);
            const grain = hash2(x * 2.1, y * 1.7) * 0.12;
            const value = Math.round(255 * Math.min(1, Math.max(0, 0.48 + macro * 0.28 + ripple * 0.20 + grain)));
            data[i] = value;
            data[i + 1] = value;
            data[i + 2] = value;
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

