// Процедурные пиксельные текстуры: зернистый песок с эоловой рябью,
// многоканальная карта почв (рябь / каменистый рег и галька / такырные трещины),
// слоистый песчаник для скал и панели брони меха.
// Рисуются в canvas и отдаются в three как CanvasTexture с NearestFilter.
import * as THREE from 'three';
import { hash2, valueNoise } from './noise.ts';

// Бесшовный тороидальный шум для процедурного полотна песка и почв
function seamlessNoise(x: number, y: number, size: number, freq: number, seedOffset = 0.0): number {
    const nx = (x / size) * Math.PI * 2;
    const ny = (y / size) * Math.PI * 2;
    const cosX = Math.cos(nx) * freq;
    const sinX = Math.sin(nx) * freq;
    const cosY = Math.cos(ny) * freq;
    const sinY = Math.sin(ny) * freq;
    return valueNoise(cosX + 10.0 + seedOffset, sinX + cosY + 10.0 - seedOffset) * 0.5 +
           valueNoise(sinY + 20.0 - seedOffset, cosY + sinX + 20.0 + seedOffset) * 0.5;
}

// Бесшовный клеточный (Вороной) паттерн для генерации гальки, камней и полигональных трещин такыра
function seamlessCellular(
    x: number,
    y: number,
    size: number,
    gridCells: number,
    seed: number
): { f1: number; f2: number; edge: number; cellId: number; dx: number; dy: number } {
    const u = (x / size) * gridCells;
    const v = (y / size) * gridCells;
    const ix = Math.floor(u);
    const iy = Math.floor(v);
    const fx = u - ix;
    const fy = v - iy;

    let f1 = 10.0;
    let f2 = 10.0;
    let bestId = 0.0;
    let bestDx = 0.0;
    let bestDy = 0.0;

    for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
            const cx = ((ix + ox) % gridCells + gridCells) % gridCells;
            const cy = ((iy + oy) % gridCells + gridCells) % gridCells;
            const h1 = hash2(cx * 1.37 + seed, cy * 2.93 - seed);
            const h2 = hash2(cx * 3.11 - seed, cy * 1.79 + seed);

            const px = ox + 0.18 + h1 * 0.64 - fx;
            const py = oy + 0.18 + h2 * 0.64 - fy;
            const d = Math.hypot(px, py);

            if (d < f1) {
                f2 = f1;
                f1 = d;
                bestId = h1;
                bestDx = px;
                bestDy = py;
            } else if (d < f2) {
                f2 = d;
            }
        }
    }

    return {
        f1,
        f2,
        edge: f2 - f1,
        cellId: bestId,
        dx: bestDx,
        dy: bestDy
    };
}

export function createSandTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context for sand texture');
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    const tau = Math.PI * 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;

            // 1. Крупномасштабные минеральные переходы (кварцевый песок, охра, железняк)
            const macro = (seamlessNoise(x, y, size, 1.5, 0.0) - 0.5) * 34;
            const meso = (seamlessNoise(x, y, size, 3.5, 13.7) - 0.5) * 20;

            // 2. Асимметричная эоловая ветровая рябь (8 периодов на тайл + Y-разветвления)
            const warp1 = (seamlessNoise(x, y, size, 2.0, 5.2) - 0.5) * 2.4;
            const warp2 = (seamlessNoise(x, y, size, 4.0, 19.4) - 0.5) * 1.15;
            const phaseMain = ((x * 8 + y * 2) / size) * tau + warp1;
            const phaseFork = ((x * 16 - y * 3) / size) * tau + warp2;

            // Асимметричный профиль ветровой волны: пологий наветренный подъем и крутая тень за гребнем
            const rawWave = Math.sin(phaseMain + 0.42 * Math.cos(phaseMain));
            const forkWave = Math.sin(phaseFork) * 0.32;
            const crest = Math.pow(Math.max(0, 0.5 + 0.5 * (rawWave + forkWave * 0.5)), 1.65);
            const trough = Math.pow(Math.max(0, 0.5 - 0.5 * rawWave), 1.45);
            const rippleDelta = crest * 32 - trough * 28;

            // 3. Ярко выраженная песчаная зернистость (кварц, охра, темный магнетит/базальт)
            const gHash1 = hash2(x * 1.73 + 0.5, y * 2.41 + 0.5);
            const gHash2 = hash2(x * 3.19 + 7.1, y * 1.97 + 3.3);
            const grain = (gHash1 * 0.65 + gHash2 * 0.35 - 0.5) * 48;

            // Темные тяжелые минеральные зерна (магнетит, роговая обманка) в ложбинках ряби
            const darkSpeck = (gHash1 < 0.095 && trough > 0.25) ? -34 : 0;

            // Светлые кварцевые и кремниевые кристаллики на гребнях ряби
            const sparkle = (gHash2 > 0.945) ? 42 : 0;

            const delta = macro + meso + rippleDelta + grain + darkSpeck + sparkle;

            // Теплый золотисто-охристый спектр со сдвигом в янтарь в тенях
            const r = 220 + delta * 1.02;
            const g = 170 + delta * 0.86 - trough * 8;
            const b = 110 + delta * 0.64 - trough * 12 + sparkle * 0.25;

            data[i]     = Math.min(255, Math.max(0, Math.round(r)));
            data[i + 1] = Math.min(255, Math.max(0, Math.round(g)));
            data[i + 2] = Math.min(255, Math.max(0, Math.round(b)));
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

// 3-канальная карта геологической детализации пустыни (256x256):
// R — профиль ветровой ряби и микрозернистости песка (для микрорельефа и теней гребней)
// G — каменистая почва Рег (галька, щебень, гравий и пустынный загар)
// B — полигональные трещины высохшей корки (такыр) и слоистые трещины породы
export function createSandDetailTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context for sand detail texture');
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    const tau = Math.PI * 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;

            // --- Канал R: микрорельеф ветровой ряби + зернистость песка ---
            const warp = (seamlessNoise(x, y, size, 2.0, 3.1) - 0.5) * 2.3;
            const fineWarp = (seamlessNoise(x, y, size, 5.0, 14.8) - 0.5) * 0.9;
            const wavePhase = ((x * 10 + y * 3) / size) * tau + warp + fineWarp;
            const asymWave = 0.5 + 0.5 * Math.sin(wavePhase + 0.48 * Math.cos(wavePhase));
            const fineGrain = (hash2(x * 2.13, y * 1.79) - 0.5) * 0.28;
            const rVal = Math.min(1, Math.max(0, asymWave * 0.78 + 0.11 + fineGrain));

            // --- Канал G: каменистая почва (галька, щебень, гравий в матрице) ---
            const cellCoarse = seamlessCellular(x, y, size, 12, 41.2);
            const cellFine = seamlessCellular(x, y, size, 26, 83.7);
            const pebbleRadius = 0.24 + cellCoarse.cellId * 0.22;
            const isPebble = cellCoarse.f1 < pebbleRadius ? 1.0 - (cellCoarse.f1 / pebbleRadius) : 0.0;
            // Направленный блик/тень на каждом камушке (верхний левый край светлее, нижний темнее)
            const pebbleShade = isPebble > 0.0
                ? Math.max(0.0, Math.min(1.0, 0.55 + (cellCoarse.dx * 1.6 + cellCoarse.dy * 1.4) + isPebble * 0.35))
                : 0.0;
            const fineGrit = cellFine.f1 < 0.32 ? (0.65 - cellFine.f1) : 0.0;
            const matrixNoise = seamlessNoise(x, y, size, 4.0, 29.0) * 0.25 + (hash2(x * 1.3, y * 2.7) - 0.5) * 0.18;
            const gVal = Math.min(1, Math.max(0, 0.32 + matrixNoise + pebbleShade * 0.52 + fineGrit * 0.35));

            // --- Канал B: такырные полигональные трещины + слоистая порода ---
            const crackWarpX = x + (seamlessNoise(x, y, size, 3.0, 61.0) - 0.5) * 14.0;
            const crackWarpY = y + (seamlessNoise(x, y, size, 3.0, 97.0) - 0.5) * 14.0;
            const takyr = seamlessCellular(crackWarpX, crackWarpY, size, 7, 19.5);
            // Темная узкая щель на границе полигонов (edge -> 0) и слегка приподнятые края плиток
            const crackMask = Math.min(1.0, Math.max(0.0, (takyr.edge - 0.035) / 0.095));
            const strataBand = 0.5 + 0.5 * Math.sin(((y * 6) / size) * tau + seamlessNoise(x, y, size, 2.0, 77.0) * 2.2);
            const bVal = Math.min(1, Math.max(0, crackMask * (0.68 + strataBand * 0.24 + (takyr.cellId - 0.5) * 0.14)));

            data[i]     = Math.round(rVal * 255);
            data[i + 1] = Math.round(gVal * 255);
            data[i + 2] = Math.round(bVal * 255);
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(12, 12);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
}

// Текстура пустынной скальной породы и плит песчаника: осадочные слои,
// трещины выветривания, пустынный загар сверху и забитый в щели песок.
export function createRockTexture(baseR = 162, baseG = 114, baseB = 76): THREE.CanvasTexture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context for rock texture');
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    const tau = Math.PI * 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;

            // Осадочная слоистость песчаника
            const warpY = (seamlessNoise(x, y, size, 2.0, 12.3) - 0.5) * 18.0;
            const strata1 = Math.sin(((y + warpY) / size) * tau * 4.0) * 22;
            const strata2 = Math.sin(((y * 2 + x * 0.4 + warpY) / size) * tau * 7.0) * 11;

            // Трещины и сколы породы
            const cell = seamlessCellular(x, y, size, 6, 53.1);
            const fracture = cell.edge < 0.055 ? -44 : (cell.edge < 0.11 ? 14 : 0);

            // Шероховатость камня и каверны выветривания
            const grain = (hash2(x * 1.91, y * 2.37) - 0.5) * 28;
            const varnish = (seamlessNoise(x, y, size, 3.0, 31.7) - 0.5) * 26;

            // Светлый песок, осевший в углублениях
            const sandPocket = (fracture < 0 && hash2(x * 0.7, y * 1.3) > 0.45) ? 36 : 0;

            const delta = strata1 + strata2 + fracture + grain + varnish;

            const r = baseR + delta + sandPocket * 1.15;
            const g = baseG + delta * 0.82 + sandPocket * 0.92;
            const b = baseB + delta * 0.62 + sandPocket * 0.58;

            data[i]     = Math.min(255, Math.max(0, Math.round(r)));
            data[i + 1] = Math.min(255, Math.max(0, Math.round(g)));
            data[i + 2] = Math.min(255, Math.max(0, Math.round(b)));
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
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
