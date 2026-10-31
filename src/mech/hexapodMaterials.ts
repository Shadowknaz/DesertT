// Материалы шестиногого шагохода: процедурные low-res текстуры прототипа
// (броня, вторичная сталь, темный каркас, жалюзи) в духе PS1 — с дизерингом,
// 15-битным квантованием и NearestFilter. Песчаный налет бури подмешивается
// к цвету материалов, как это было у прежнего меха.
import * as THREE from 'three';
import { PALETTE, PS1_SNAP } from '../config.ts';
import { applyPS1VertexSnap } from '../render/ps1Material.ts';

const bayer4x4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
];

// Рисует текстуру по пиксельной функции и квантует цвет под PS1
function createPS1Texture(
    width: number,
    height: number,
    drawFn: (x: number, y: number, w: number, h: number, dither: number) => [number, number, number] | number[]
): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(width, height);
    const data = img.data;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dither = (bayer4x4[y & 3][x & 3] / 16.0 - 0.5) * 12;
            const rgb = drawFn(x, y, width, height, dither);
            const r = Math.min(255, Math.max(0, Math.floor((rgb[0] + dither) / 8) * 8));
            const g = Math.min(255, Math.max(0, Math.floor((rgb[1] + dither) / 8) * 8));
            const b = Math.min(255, Math.max(0, Math.floor((rgb[2] + dither) / 8) * 8));
            const idx = (y * width + x) * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
}

export interface HexapodMaterials {
    armorMat: THREE.Material;
    secondaryMat: THREE.Material;
    darkMat: THREE.Material;
    louverMat: THREE.Material;
    chromeMat: THREE.Material;
    ochreMat: THREE.Material;
    slitMat: THREE.Material;
    lensMat: THREE.Material;
    rimMat: THREE.Material;
    setDustCoat(amount: number): void;
}

export function createHexapodMaterials(): HexapodMaterials {
    // Основная броня: теплый серо-оливковый бетон/сталь с ржавыми кромками
    const armorTex = createPS1Texture(64, 64, (x, y, w, h) => {
        let r = 152, g = 150, b = 138;
        const border = x < 2 || x >= w - 2 || y < 2 || y >= h - 2;
        const seam = (y === 31 || y === 32 || x === 31 || x === 32);
        const rustHash = ((x * 29 + y * 53) ^ (x * 7)) & 31;

        if (border) {
            if (rustHash < 7) {
                r = 128; g = 94; b = 62;
            } else {
                r -= 28; g -= 28; b -= 27;
            }
        } else if (seam) {
            r -= 20; g -= 20; b -= 19;
        }

        // Болты/заклепки вдоль швов
        const isRivet =
            ((x === 5 || x === 27 || x === 36 || x === 58) &&
             (y === 5 || y === 27 || y === 36 || y === 58));
        if (isRivet) {
            r -= 32; g -= 32; b -= 30;
        }

        const grime = ((x * 13 + y * 5) % 17 === 0) ? -8 : (((x * 23 + y * 11) % 29 === 0) ? 6 : 0);
        return [r + grime, g + grime, b + grime];
    });

    // Вторичная броня: темнее, с вертикальными ребрами и охристой маркировкой
    const secondaryArmorTex = createPS1Texture(64, 64, (x, y, w, h) => {
        let r = 122, g = 121, b = 114;
        const border = x < 2 || x >= w - 2 || y < 2 || y >= h - 2;
        const vRib = (x % 16 === 0 || x % 16 === 1) && y > 10 && y < h - 10;
        if (border) {
            r -= 24; g -= 24; b -= 23;
        } else if (vRib) {
            r -= 14; g -= 14; b -= 14;
        }
        if (y > 54 && y < 60 && ((x + y) % 8 < 4)) {
            r = 142; g = 104; b = 52;
        }
        const noise = ((x * 19 ^ y * 37) % 11 === 0) ? -6 : 0;
        return [r + noise, g + noise, b + noise];
    });

    // Темный конструкционный металл: фермы, суставы, цилиндры
    const darkMetalTex = createPS1Texture(32, 32, (x, y, w, h) => {
        let r = 70, g = 72, b = 74;
        if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) {
            r -= 16; g -= 16; b -= 16;
        }
        if ((x + y) % 7 === 0) {
            r += 6; g += 6; b += 6;
        }
        return [r, g, b];
    });

    // Решетки вентиляции: жалюзи воздухозаборников и башни охлаждения
    const louverTex = createPS1Texture(32, 32, (x, y, w, h) => {
        if (x < 3 || x >= w - 3 || y < 3 || y >= h - 3) {
            return [100, 102, 98];
        }
        if (x === 15 || x === 16) {
            return [86, 88, 84];
        }
        const slat = (y % 3 === 0);
        return slat ? [32, 33, 33] : [74, 76, 74];
    });

    const armorMat = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        map: armorTex, flatShading: true
    }), PS1_SNAP.mech);

    const secondaryMat = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        map: secondaryArmorTex, flatShading: true
    }), PS1_SNAP.mech);

    const darkMat = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        map: darkMetalTex, flatShading: true
    }), PS1_SNAP.mech);

    const louverMat = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        map: louverTex, flatShading: true
    }), PS1_SNAP.mech);

    // Светлые штоки гидроцилиндров и охристые метки — цвет без карты
    const chromeMat = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        color: 0xc2c7ca, flatShading: true
    }), PS1_SNAP.mech);

    const ochreMat = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        color: 0xb5894a, flatShading: true
    }), PS1_SNAP.mech);

    // Глубокая тень смотровой щели: базовый материал без освещения
    const slitMat = applyPS1VertexSnap(new THREE.MeshBasicMaterial({
        color: 0x111314
    }), PS1_SNAP.mech);

    // Темная линза камеры и светлый ободок объектива
    const lensMat = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        color: 0x1c2226, flatShading: true
    }), PS1_SNAP.mech);

    const rimMat = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        color: 0x747876, flatShading: true
    }), PS1_SNAP.mech);

    const materials = {
        armorMat, secondaryMat, darkMat, louverMat,
        chromeMat, ochreMat, slitMat, lensMat, rimMat
    };

    // Песчаный налет: буря пылит броню. Базовые цвета — белый множитель
    // карты, поэтому lerp к пыльному тону только притемняет текстуру.
    const dustColor = new THREE.Color(PALETTE.dustCoat);
    const tinted = [armorMat, secondaryMat, darkMat, louverMat, chromeMat, ochreMat, lensMat, rimMat] as (THREE.MeshLambertMaterial | THREE.MeshBasicMaterial)[];
    const baseColors = tinted.map(mat => mat.color.clone());

    function setDustCoat(amount: number): void {
        const a = THREE.MathUtils.clamp(amount, 0.0, 1.0) * 0.6;
        for (let i = 0; i < tinted.length; i++) {
            tinted[i].color.copy(baseColors[i]).lerp(dustColor, a * 0.8);
        }
    }

    return { ...materials, setDustCoat };
}

