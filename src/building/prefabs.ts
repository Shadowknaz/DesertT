// Генератор детализированных строительных префабов в стиле PS1 из module.html:
// 1. Процедурные текстуры с дизерингом Байера 4×4 (пустынная охра, разметка безопасности,
//    ржавый каркас, бункерный бетон, рифленый настил, физическое бронестекло).
// 2. 7 составных моделей (Foundation, SolidWall, WindowWall, DoorWall, Ceiling,
//    StaircaseRailed, StaircaseOpen).
// 3. Запекание иерархии THREE.Group каждого модуля в единую BufferGeometry с группами
//    материалов для рендера через один InstancedMesh на тип модуля.
import * as THREE from 'three';
import {
    CEILING_THICK,
    FOUND_HEIGHT,
    MODULE_DEPTH,
    MODULE_WIDTH,
    WALL_HEIGHT,
    WALL_THICK
} from './catalog.ts';
import type { PieceType } from './types.ts';

const bayer4x4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
];

export function createPS1Texture(
    width: number,
    height: number,
    drawFn: (x: number, y: number, w: number, h: number, dither: number) => [number, number, number],
    repeatX = 1,
    repeatY = 1
): THREE.Texture {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dither = (bayer4x4[y & 3][x & 3] / 16.0 - 0.5) * 10;
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

    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

export interface BuildingMaterialLibrary {
    textures: THREE.Texture[];
    materials: Record<string, THREE.Material>;
    matDesertArmor: THREE.MeshStandardMaterial;
    matHazardStripe: THREE.MeshStandardMaterial;
    matRustyFrame: THREE.MeshStandardMaterial;
    matConcrete: THREE.MeshStandardMaterial;
    matDeckGrate: THREE.MeshStandardMaterial;
    matDarkFrame: THREE.MeshStandardMaterial;
    matChrome: THREE.MeshStandardMaterial;
    matAmberLight: THREE.MeshStandardMaterial;
    matRealGlass: THREE.MeshPhysicalMaterial;
    dispose(): void;
}

let _sharedMaterials: BuildingMaterialLibrary | null = null;

export function getBuildingMaterials(isSoftwareGl = false): BuildingMaterialLibrary {
    if (_sharedMaterials) return _sharedMaterials;

    // 1. Матовая пустынная охра с панельными швами, заклепками и легким износом
    const desertArmorTex = createPS1Texture(64, 64, (x, y, w, h) => {
        let r = 188, g = 145, b = 78;
        const border = (x < 2 || y < 2 || x >= w - 2 || y >= h - 2 || x === 31 || y === 31);
        if (border) {
            r = 84; g = 74; b = 62;
        } else {
            const rx = x % 32, ry = y % 32;
            const isRivet = (rx === 4 || rx === 27) && (ry === 4 || ry === 27);
            if (isRivet) {
                r = 62; g = 56; b = 50;
            } else {
                const wear = ((x * 29 + y * 47) & 31) < 3 ? -14 : 0;
                r += wear; g += wear; b += wear;
            }
        }
        return [r, g, b];
    });

    // 2. Предупреждающая разметка (Hazard Stripes)
    const hazardStripeTex = createPS1Texture(32, 32, (x, y) => {
        const stripe = ((x + y) >> 2) & 1;
        return stripe ? [204, 152, 44] : [38, 36, 34];
    });

    // 3. Темный конструкционный металл каркаса с болтами и фасками
    const rustyFrameTex = createPS1Texture(32, 32, (x, y, w, h) => {
        let r = 74, g = 70, b = 66;
        const border = (x < 2 || y < 2 || x >= w - 2 || y >= h - 2);
        if (border) {
            r -= 18; g -= 18; b -= 18;
        } else if ((x === 4 || x === w - 5) && (y % 8 === 4)) {
            r += 24; g += 22; b += 18;
        }
        return [r, g, b];
    });

    // 4. Архитектурный бетон с опалубочными швами и анкерными гнездами
    const bunkerConcreteTex = createPS1Texture(64, 64, (x, y, w) => {
        let r = 118, g = 114, b = 108;
        const seam = (x < 2 || y < 2 || y === 31);
        if (seam) {
            r -= 22; g -= 22; b -= 22;
        } else if ((x === 8 || x === w - 9) && (y === 16 || y === 48)) {
            r -= 32; g -= 32; b -= 32;
        }
        return [r, g, b];
    });

    // 5. Рифленый металлический настил
    const deckGrateTex = createPS1Texture(32, 32, (x, y) => {
        let r = 82, g = 84, b = 88;
        const grid = (x % 8 === 0) || (y % 8 === 0);
        if (grid) {
            r -= 20; g -= 20; b -= 20;
        } else if ((x + y) % 4 === 0) {
            r += 10; g += 10; b += 12;
        }
        return [r, g, b];
    }, 2, 2);

    const matDesertArmor = new THREE.MeshStandardMaterial({
        map: desertArmorTex,
        emissiveMap: desertArmorTex,
        emissive: 0xffd29c,
        emissiveIntensity: 0.28,
        color: 0xffffff,
        roughness: 0.82,
        metalness: 0.04,
        flatShading: true
    });
    const matHazardStripe = new THREE.MeshStandardMaterial({
        map: hazardStripeTex,
        emissiveMap: hazardStripeTex,
        emissive: 0xffd280,
        emissiveIntensity: 0.32,
        color: 0xffffff,
        roughness: 0.78,
        metalness: 0.04,
        flatShading: true
    });
    const matRustyFrame = new THREE.MeshStandardMaterial({
        map: rustyFrameTex,
        emissiveMap: rustyFrameTex,
        emissive: 0xd99b6c,
        emissiveIntensity: 0.26,
        color: 0xffffff,
        roughness: 0.75,
        metalness: 0.08,
        flatShading: true
    });
    const matConcrete = new THREE.MeshStandardMaterial({
        map: bunkerConcreteTex,
        emissiveMap: bunkerConcreteTex,
        emissive: 0xd8c3a5,
        emissiveIntensity: 0.25,
        color: 0xffffff,
        roughness: 0.88,
        metalness: 0.02,
        flatShading: true
    });
    const matDeckGrate = new THREE.MeshStandardMaterial({
        map: deckGrateTex,
        emissiveMap: deckGrateTex,
        emissive: 0xc2b09b,
        emissiveIntensity: 0.24,
        color: 0xffffff,
        roughness: 0.72,
        metalness: 0.10,
        flatShading: true
    });
    const matDarkFrame = new THREE.MeshStandardMaterial({
        color: 0x3d3f44,
        emissive: 0x1c1916,
        emissiveIntensity: 0.35,
        roughness: 0.68,
        metalness: 0.12,
        flatShading: true
    });
    const matChrome = new THREE.MeshStandardMaterial({
        color: 0xd0d7de,
        emissive: 0x4a4e54,
        emissiveIntensity: 0.3,
        roughness: 0.35,
        metalness: 0.25,
        flatShading: true
    });
    const matAmberLight = new THREE.MeshStandardMaterial({
        color: 0xffae38,
        emissive: 0xff7b14,
        emissiveIntensity: 0.95,
        roughness: 0.25,
        flatShading: true
    });

    // Настоящее физическое стекло из module.html (с безопасным fallback на software WebGL)
    const matRealGlass = new THREE.MeshPhysicalMaterial({
        color: 0xffe6c4,
        emissive: 0x4a3822,
        emissiveIntensity: 0.25,
        metalness: 0.0,
        roughness: 0.08,
        transmission: isSoftwareGl ? 0.0 : 0.88,
        transparent: true,
        opacity: isSoftwareGl ? 0.46 : 0.92,
        thickness: 0.52,
        ior: 1.52,
        attenuationColor: new THREE.Color(0xffe6c4),
        attenuationDistance: 2.4,
        envMapIntensity: 1.35,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        specularIntensity: 1.0
    });

    const textures = [desertArmorTex, hazardStripeTex, rustyFrameTex, bunkerConcreteTex, deckGrateTex];
    const materials = {
        matDesertArmor,
        matHazardStripe,
        matRustyFrame,
        matConcrete,
        matDeckGrate,
        matDarkFrame,
        matChrome,
        matAmberLight,
        matRealGlass
    };

    _sharedMaterials = {
        textures,
        materials,
        matDesertArmor,
        matHazardStripe,
        matRustyFrame,
        matConcrete,
        matDeckGrate,
        matDarkFrame,
        matChrome,
        matAmberLight,
        matRealGlass,
        dispose() {
            textures.forEach(t => t.dispose());
            Object.values(materials).forEach(m => m.dispose());
            _sharedMaterials = null;
        }
    };
    return _sharedMaterials;
}

function addPart(
    parent: THREE.Object3D,
    geom: THREE.BufferGeometry,
    mat: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0
): THREE.Mesh {
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
}

function buildDetailedWallFrame(wallGroup: THREE.Group, mats: BuildingMaterialLibrary): void {
    const { matRustyFrame, matDarkFrame } = mats;
    // Нижний опорный цоколь и верхняя венчающая балка
    addPart(wallGroup, new THREE.BoxGeometry(MODULE_WIDTH, 0.22, WALL_THICK + 0.06), matRustyFrame, 0, 0.11, 0);
    addPart(wallGroup, new THREE.BoxGeometry(MODULE_WIDTH - 0.12, 0.08, WALL_THICK + 0.12), matDarkFrame, 0, 0.04, 0);

    addPart(wallGroup, new THREE.BoxGeometry(MODULE_WIDTH, 0.20, WALL_THICK + 0.06), matRustyFrame, 0, WALL_HEIGHT - 0.10, 0);
    addPart(wallGroup, new THREE.BoxGeometry(MODULE_WIDTH - 0.16, 0.06, WALL_THICK + 0.10), matDarkFrame, 0, WALL_HEIGHT - 0.03, 0);

    // Верхние стыковочные шипы для модульной сборки этажей
    for (const sx of [-1.15, 0, 1.15]) {
        addPart(wallGroup, new THREE.BoxGeometry(0.24, 0.05, 0.18), matDarkFrame, sx, WALL_HEIGHT + 0.025, 0);
    }

    // Боковые силовые колонны с внешними полками, замковыми пазами и угловыми косынками
    for (const s of [-1, 1]) {
        const colX = s * (MODULE_WIDTH * 0.5 - 0.15);
        addPart(wallGroup, new THREE.BoxGeometry(0.30, WALL_HEIGHT, WALL_THICK), matRustyFrame, colX, WALL_HEIGHT * 0.5, 0);

        for (const fz of [-1, 1]) {
            addPart(wallGroup, new THREE.BoxGeometry(0.16, WALL_HEIGHT - 0.20, 0.05), matDarkFrame, colX, WALL_HEIGHT * 0.5, fz * (WALL_THICK * 0.5 + 0.02));
            addPart(wallGroup, new THREE.BoxGeometry(0.22, 0.22, 0.04), matDarkFrame, colX - s * 0.18, 0.28, fz * (WALL_THICK * 0.5 + 0.01), 0, 0, s * Math.PI / 4);
            addPart(wallGroup, new THREE.BoxGeometry(0.22, 0.22, 0.04), matDarkFrame, colX - s * 0.18, WALL_HEIGHT - 0.26, fz * (WALL_THICK * 0.5 + 0.01), 0, 0, s * Math.PI / 4);
        }

        // Торцевые замковые соединения (для стыковки стен в ряд)
        addPart(wallGroup, new THREE.BoxGeometry(0.05, 0.55, 0.16), matDarkFrame, s * (MODULE_WIDTH * 0.5 + 0.015), 0.90, 0);
        addPart(wallGroup, new THREE.BoxGeometry(0.05, 0.55, 0.16), matDarkFrame, s * (MODULE_WIDTH * 0.5 + 0.015), 2.10, 0);
    }
}

// 1. ФУНДАМЕНТ (ДЕТАЛИЗИРОВАННАЯ ИНДУСТРИАЛЬНАЯ ПЛИТА — 3.2 × 0.64 × 3.2 м)
export function createFoundationModel(mats = getBuildingMaterials()): THREE.Group {
    const group = new THREE.Group();
    const { matDarkFrame, matConcrete, matRustyFrame, matDesertArmor, matHazardStripe, matDeckGrate } = mats;

    // Подземная свайная юбка-цоколь (-0.42 м вниз), чтобы на склонах дюн углы фундамента всегда уходили в песок
    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.14, 0.44, MODULE_DEPTH - 0.14), matConcrete, 0, -0.21, 0);

    // Ступенчатая нижняя бетонная подошва и основное тело фундамента
    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.06, 0.14, MODULE_DEPTH - 0.06), matDarkFrame, 0, 0.07, 0);
    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.20, FOUND_HEIGHT - 0.18, MODULE_DEPTH - 0.20), matConcrete, 0, 0.14 + (FOUND_HEIGHT - 0.18) * 0.5, 0);

    // 4 массивных угловых быка со скошенными контрфорсами и посадочными гнездами под колонны
    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
            const cx = sx * 1.37;
            const cz = sz * 1.37;
            addPart(group, new THREE.BoxGeometry(0.46, FOUND_HEIGHT + 0.02, 0.46), matRustyFrame, cx, (FOUND_HEIGHT + 0.02) * 0.5, cz);
            addPart(group, new THREE.BoxGeometry(0.52, 0.56, 0.52), matDarkFrame, cx, -0.12, cz);
            addPart(group, new THREE.BoxGeometry(0.32, 0.06, 0.32), matDarkFrame, cx, FOUND_HEIGHT + 0.02, cz);
        }
    }

    // Боковые бронепанели, вертикальные ребра жесткости и полосы безопасности
    for (const side of [-1, 1]) {
        addPart(group, new THREE.BoxGeometry(2.08, 0.30, 0.06), matDesertArmor, 0, 0.36, side * 1.51);
        addPart(group, new THREE.BoxGeometry(1.56, 0.08, 0.08), matHazardStripe, 0, 0.18, side * 1.52);
        for (const rx of [-0.65, 0, 0.65]) {
            addPart(group, new THREE.BoxGeometry(0.12, FOUND_HEIGHT - 0.08, 0.10), matRustyFrame, rx, FOUND_HEIGHT * 0.5, side * 1.51);
        }

        addPart(group, new THREE.BoxGeometry(0.06, 0.30, 2.08), matDesertArmor, side * 1.51, 0.36, 0);
        addPart(group, new THREE.BoxGeometry(0.08, 0.08, 1.56), matHazardStripe, side * 1.52, 0.18, 0);
        for (const rz of [-0.65, 0, 0.65]) {
            addPart(group, new THREE.BoxGeometry(0.10, FOUND_HEIGHT - 0.08, 0.12), matRustyFrame, side * 1.51, FOUND_HEIGHT * 0.5, rz);
        }
    }

    // Верхний стальной комингс, секционный рифленый настил и центральный технический люк
    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.10, 0.08, MODULE_DEPTH - 0.10), matRustyFrame, 0, FOUND_HEIGHT - 0.04, 0);

    for (const gx of [-0.68, 0.68]) {
        for (const gz of [-0.68, 0.68]) {
            addPart(group, new THREE.BoxGeometry(1.18, 0.04, 1.18), matDeckGrate, gx, FOUND_HEIGHT + 0.01, gz);
        }
    }
    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.44, 0.05, 0.14), matDarkFrame, 0, FOUND_HEIGHT + 0.01, 0);
    addPart(group, new THREE.BoxGeometry(0.14, 0.05, MODULE_DEPTH - 0.44), matDarkFrame, 0, FOUND_HEIGHT + 0.01, 0);

    addPart(group, new THREE.BoxGeometry(0.76, 0.06, 0.76), matRustyFrame, 0, FOUND_HEIGHT + 0.02, 0);
    addPart(group, new THREE.BoxGeometry(0.58, 0.07, 0.58), matDesertArmor, 0, FOUND_HEIGHT + 0.025, 0);

    return group;
}

// 2. ГЛУХАЯ СТЕНА (ДЕТАЛИЗИРОВАННАЯ БРОНЕСТЕНА — 3.2 × 3.0 × 0.38 м)
export function createSolidWallModel(mats = getBuildingMaterials()): THREE.Group {
    const group = new THREE.Group();
    const { matDesertArmor, matRustyFrame, matHazardStripe, matDarkFrame } = mats;
    buildDetailedWallFrame(group, mats);

    const panelHeights = [0.64, 1.50, 2.36];
    for (const py of panelHeights) {
        addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.56, 0.74, WALL_THICK - 0.08), matDesertArmor, 0, py, 0);
        for (const fz of [-1, 1]) {
            addPart(group, new THREE.BoxGeometry(1.12, 0.54, 0.05), matDesertArmor, -0.60, py, fz * (WALL_THICK * 0.5 - 0.02));
            addPart(group, new THREE.BoxGeometry(1.12, 0.54, 0.05), matDesertArmor, 0.60, py, fz * (WALL_THICK * 0.5 - 0.02));
        }
    }

    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.48, 0.10, WALL_THICK + 0.02), matRustyFrame, 0, 1.07, 0);
    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.48, 0.10, WALL_THICK + 0.02), matRustyFrame, 0, 1.93, 0);
    addPart(group, new THREE.BoxGeometry(0.14, WALL_HEIGHT - 0.40, WALL_THICK + 0.02), matRustyFrame, 0, WALL_HEIGHT * 0.5, 0);

    for (const fz of [-1, 1]) {
        addPart(group, new THREE.BoxGeometry(2.20, 0.12, 0.06), matHazardStripe, 0, 0.28, fz * (WALL_THICK * 0.5));
        addPart(group, new THREE.BoxGeometry(0.76, 0.22, 0.06), matDarkFrame, -0.60, 2.36, fz * (WALL_THICK * 0.5 + 0.01));
        addPart(group, new THREE.BoxGeometry(0.76, 0.22, 0.06), matDarkFrame, 0.60, 2.36, fz * (WALL_THICK * 0.5 + 0.01));
    }

    return group;
}

// 3. СТЕНА-ОКНО (ДЕТАЛИЗИРОВАННАЯ БРОНЕРАМА С ФИЗИЧЕСКИМ СТЕКЛОМ — 3.2 × 3.0 × 0.38 м)
export function createWindowWallModel(mats = getBuildingMaterials()): THREE.Group {
    const group = new THREE.Group();
    const { matDesertArmor, matRustyFrame, matHazardStripe, matDarkFrame, matRealGlass } = mats;
    buildDetailedWallFrame(group, mats);

    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.56, 0.78, WALL_THICK - 0.06), matDesertArmor, 0, 0.60, 0);
    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.56, 0.58, WALL_THICK - 0.06), matDesertArmor, 0, 2.52, 0);

    for (const s of [-1, 1]) {
        addPart(group, new THREE.BoxGeometry(0.44, 1.24, WALL_THICK - 0.06), matDesertArmor, s * 1.09, 1.60, 0);
        addPart(group, new THREE.BoxGeometry(0.28, 0.96, WALL_THICK), matRustyFrame, s * 1.09, 1.60, 0);
    }

    addPart(group, new THREE.BoxGeometry(1.96, 0.12, WALL_THICK + 0.12), matRustyFrame, 0, 0.98, 0);
    addPart(group, new THREE.BoxGeometry(1.88, 0.06, WALL_THICK + 0.16), matHazardStripe, 0, 0.90, 0);
    addPart(group, new THREE.BoxGeometry(1.96, 0.14, WALL_THICK + 0.14), matRustyFrame, 0, 2.22, 0);

    for (const s of [-1, 1]) {
        addPart(group, new THREE.BoxGeometry(0.12, 1.26, WALL_THICK + 0.08), matDarkFrame, s * 0.88, 1.60, 0);
    }

    addPart(group, new THREE.BoxGeometry(0.10, 1.16, WALL_THICK + 0.06), matDarkFrame, 0, 1.60, 0);

    for (const fz of [-1, 1]) {
        for (const rx of [-0.68, 0, 0.68]) {
            addPart(group, new THREE.BoxGeometry(0.12, 0.62, 0.08), matRustyFrame, rx, 0.56, fz * (WALL_THICK * 0.5 + 0.01));
        }
    }

    addPart(group, new THREE.BoxGeometry(1.66, 1.12, 0.14), matRealGlass, 0, 1.60, 0);

    return group;
}

// 4a. ПОРТАЛЬНАЯ РАМА ГЕРМОДВЕРИ БЕЗ ПОДВИЖНОЙ СТВОРКИ (ДЛЯ РЕНДЕРА В ЧАНКЕ)
export function createDoorFrameModel(mats = getBuildingMaterials()): THREE.Group {
    const group = new THREE.Group();
    const {
        matDesertArmor,
        matRustyFrame,
        matDarkFrame,
        matChrome,
        matAmberLight,
        matHazardStripe
    } = mats;
    buildDetailedWallFrame(group, mats);

    for (const s of [-1, 1]) {
        addPart(group, new THREE.BoxGeometry(0.54, WALL_HEIGHT - 0.38, WALL_THICK - 0.06), matDesertArmor, s * 1.05, WALL_HEIGHT * 0.5, 0);
        addPart(group, new THREE.BoxGeometry(0.16, 2.26, WALL_THICK + 0.10), matRustyFrame, s * 0.74, 1.24, 0);
        addPart(group, new THREE.BoxGeometry(0.10, 1.96, WALL_THICK + 0.14), matDarkFrame, s * 0.70, 1.20, 0);
        addPart(group, new THREE.BoxGeometry(0.26, 0.26, WALL_THICK + 0.08), matRustyFrame, s * 0.58, 2.20, 0, 0, 0, Math.PI / 4);
    }

    addPart(group, new THREE.BoxGeometry(1.56, 0.52, WALL_THICK - 0.06), matDesertArmor, 0, 2.55, 0);
    addPart(group, new THREE.BoxGeometry(1.68, 0.18, WALL_THICK + 0.12), matRustyFrame, 0, 2.32, 0);

    for (const fz of [-1, 1]) {
        addPart(group, new THREE.BoxGeometry(1.24, 0.20, 0.10), matDarkFrame, -0.10, 2.56, fz * (WALL_THICK * 0.5 + 0.03));
        addPart(group, new THREE.CylinderGeometry(0.035, 0.035, 0.65, 8), matRustyFrame, -0.32, 2.56, fz * (WALL_THICK * 0.5 + 0.09), 0, 0, Math.PI / 2);
        addPart(group, new THREE.CylinderGeometry(0.020, 0.020, 0.55, 8), matChrome, 0.18, 2.56, fz * (WALL_THICK * 0.5 + 0.09), 0, 0, Math.PI / 2);

        addPart(group, new THREE.BoxGeometry(0.24, 0.10, 0.08), matDarkFrame, 0.52, 2.56, fz * (WALL_THICK * 0.5 + 0.03));
        addPart(group, new THREE.BoxGeometry(0.16, 0.06, 0.09), matAmberLight, 0.52, 2.56, fz * (WALL_THICK * 0.5 + 0.035));

        addPart(group, new THREE.BoxGeometry(0.22, 0.36, 0.08), matDarkFrame, 1.04, 1.32, fz * (WALL_THICK * 0.5 + 0.02));
        addPart(group, new THREE.BoxGeometry(0.14, 0.10, 0.09), matAmberLight, 1.04, 1.40, fz * (WALL_THICK * 0.5 + 0.025));
        addPart(group, new THREE.BoxGeometry(0.14, 0.12, 0.09), matHazardStripe, 1.04, 1.23, fz * (WALL_THICK * 0.5 + 0.025));
    }

    addPart(group, new THREE.BoxGeometry(1.48, 0.14, WALL_THICK + 0.12), matDarkFrame, 0, 0.16, 0);
    addPart(group, new THREE.BoxGeometry(1.36, 0.06, WALL_THICK + 0.16), matHazardStripe, 0, 0.12, 0);

    return group;
}

// 4b. ПОДВИЖНОЕ БРОНИРОВАННОЕ ПОЛОТНО ГЕРМОДВЕРИ (СТВОРКА)
export function createDoorLeafModel(mats = getBuildingMaterials()): THREE.Group {
    const group = new THREE.Group();
    const {
        matDesertArmor,
        matRustyFrame,
        matDarkFrame,
        matChrome,
        matHazardStripe,
        matRealGlass
    } = mats;

    const doorGroup = new THREE.Group();
    doorGroup.position.set(0, 1.24, 0);
    group.add(doorGroup);

    addPart(doorGroup, new THREE.BoxGeometry(1.32, 1.06, 0.18), matRustyFrame, 0, -0.48, 0);
    addPart(doorGroup, new THREE.BoxGeometry(1.32, 0.24, 0.18), matRustyFrame, 0, 0.90, 0);
    for (const s of [-1, 1]) {
        addPart(doorGroup, new THREE.BoxGeometry(0.36, 0.74, 0.18), matRustyFrame, s * 0.48, 0.42, 0);
    }

    addPart(doorGroup, new THREE.BoxGeometry(1.18, 0.86, 0.22), matDesertArmor, 0, -0.50, 0);
    addPart(doorGroup, new THREE.BoxGeometry(1.18, 0.16, 0.22), matDesertArmor, 0, 0.90, 0);
    for (const s of [-1, 1]) {
        addPart(doorGroup, new THREE.BoxGeometry(0.26, 0.68, 0.22), matDesertArmor, s * 0.46, 0.42, 0);
    }

    addPart(doorGroup, new THREE.BoxGeometry(1.28, 0.18, 0.26), matDarkFrame, 0, -0.02, 0);
    addPart(doorGroup, new THREE.BoxGeometry(1.22, 0.10, 0.28), matHazardStripe, 0, -0.02, 0);

    for (const ry of [-0.66, -0.28, 0.32, 0.68]) {
        addPart(doorGroup, new THREE.CylinderGeometry(0.028, 0.028, 1.38, 6), matChrome, 0, ry, 0, 0, 0, Math.PI / 2);
    }
    addPart(doorGroup, new THREE.BoxGeometry(0.96, 0.10, 0.25), matRustyFrame, 0, -0.52, 0, 0, 0, 0.42);
    addPart(doorGroup, new THREE.BoxGeometry(0.96, 0.10, 0.25), matRustyFrame, 0, -0.52, 0, 0, 0, -0.42);

    for (const fz of [-1, 1]) {
        addPart(doorGroup, new THREE.BoxGeometry(0.06, 0.34, 0.08), matChrome, 0.44, -0.02, fz * 0.16);
    }

    addPart(doorGroup, new THREE.BoxGeometry(0.68, 0.08, 0.24), matDarkFrame, 0, 0.09, 0);
    addPart(doorGroup, new THREE.BoxGeometry(0.68, 0.08, 0.24), matDarkFrame, 0, 0.75, 0);
    for (const s of [-1, 1]) {
        addPart(doorGroup, new THREE.BoxGeometry(0.08, 0.74, 0.24), matDarkFrame, s * 0.30, 0.42, 0);
    }
    addPart(doorGroup, new THREE.BoxGeometry(0.54, 0.60, 0.12), matRealGlass, 0, 0.42, 0);

    return group;
}

// 4. СТЕНА С ДВЕРЬЮ В СБОРЕ (ДЛЯ ПРИЗРАКА И КАТАЛОГА — 3.2 × 3.0 × 0.38 м)
export function createDoorWallModel(mats = getBuildingMaterials()): THREE.Group {
    const group = createDoorFrameModel(mats);
    const leaf = createDoorLeafModel(mats);
    group.add(leaf);
    return group;
}

// 5. ПОТОЛОК / ПЕРЕКРЫТИЕ (СИЛОВАЯ ПЛИТА ПЕРЕКРЫТИЯ — 3.2 × 0.22 × 3.2 м)
export function createCeilingModel(mats = getBuildingMaterials()): THREE.Group {
    const group = new THREE.Group();
    const { matRustyFrame, matDarkFrame, matDesertArmor, matDeckGrate, matHazardStripe } = mats;

    // Несущий периметральный стальной пояс перекрытия
    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH, CEILING_THICK, MODULE_DEPTH), matRustyFrame, 0, -CEILING_THICK * 0.5 + 0.02, 0);

    // 4 угловых замковых узла под стойки верхнего этажа
    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
            addPart(group, new THREE.BoxGeometry(0.38, CEILING_THICK + 0.04, 0.38), matDarkFrame, sx * 1.38, -CEILING_THICK * 0.5 + 0.02, sz * 1.38);
        }
    }

    // Нижние потолочные бронекассеты (софиты) и перекрестные двутавровые балки
    for (const gx of [-0.68, 0.68]) {
        for (const gz of [-0.68, 0.68]) {
            addPart(group, new THREE.BoxGeometry(1.16, 0.05, 1.16), matDesertArmor, gx, -CEILING_THICK - 0.005, gz);
            addPart(group, new THREE.BoxGeometry(1.18, 0.04, 1.18), matDeckGrate, gx, 0.03, gz);
        }
    }
    addPart(group, new THREE.BoxGeometry(MODULE_WIDTH - 0.24, 0.08, 0.18), matDarkFrame, 0, -CEILING_THICK + 0.01, 0);
    addPart(group, new THREE.BoxGeometry(0.18, 0.08, MODULE_DEPTH - 0.24), matDarkFrame, 0, -CEILING_THICK + 0.01, 0);

    // Торцевые полосы безопасности по периметру плиты перекрытия
    for (const side of [-1, 1]) {
        addPart(group, new THREE.BoxGeometry(2.12, 0.07, 0.04), matHazardStripe, 0, -CEILING_THICK * 0.45, side * (MODULE_DEPTH * 0.5 + 0.01));
        addPart(group, new THREE.BoxGeometry(0.04, 0.07, 2.12), matHazardStripe, side * (MODULE_WIDTH * 0.5 + 0.01), -CEILING_THICK * 0.45, 0);
    }

    return group;
}

// 6 & 7. КОНСТРУКТОР ЛЕСТНИЦ (С ПЕРИЛАМИ И БЕЗ ПЕРИЛ — 1.8 × 3.0 × 3.2 м)
export function createStaircaseModel(withRailings = true, mats = getBuildingMaterials()): THREE.Group {
    const group = new THREE.Group();
    const { matRustyFrame, matDeckGrate, matHazardStripe, matDarkFrame, matDesertArmor } = mats;

    const STAIR_WIDTH = 1.72;
    const TOTAL_HEIGHT = WALL_HEIGHT;
    const TOTAL_RUN = 2.20;
    const LANDING_DEPTH = 0.92;
    const landingZ = -1.12;

    addPart(group, new THREE.BoxGeometry(STAIR_WIDTH + 0.20, 0.18, LANDING_DEPTH), matRustyFrame, 0, TOTAL_HEIGHT - 0.09, landingZ);
    addPart(group, new THREE.BoxGeometry(STAIR_WIDTH + 0.04, 0.04, LANDING_DEPTH - 0.10), matDeckGrate, 0, TOTAL_HEIGHT + 0.01, landingZ);
    addPart(group, new THREE.BoxGeometry(STAIR_WIDTH + 0.16, 0.08, 0.06), matHazardStripe, 0, TOTAL_HEIGHT - 0.08, landingZ - LANDING_DEPTH * 0.5 - 0.01);

    for (const s of [-1, 1]) {
        const colX = s * (STAIR_WIDTH * 0.5);
        addPart(group, new THREE.BoxGeometry(0.20, TOTAL_HEIGHT - 0.10, 0.20), matRustyFrame, colX, (TOTAL_HEIGHT - 0.10) * 0.5, landingZ - 0.24);
        addPart(group, new THREE.BoxGeometry(0.32, 0.12, 0.32), matDarkFrame, colX, 0.06, landingZ - 0.24);
        addPart(group, new THREE.BoxGeometry(0.10, 1.45, 0.10), matDarkFrame, colX, 1.55, landingZ + 0.26, 0.68, 0, 0);
    }
    addPart(group, new THREE.BoxGeometry(STAIR_WIDTH, 0.12, 0.12), matDarkFrame, 0, 1.45, landingZ - 0.24);
    addPart(group, new THREE.BoxGeometry(STAIR_WIDTH, 0.08, 0.08), matRustyFrame, 0, 0.72, landingZ - 0.24);

    const stringerLen = Math.hypot(TOTAL_HEIGHT - 0.10, TOTAL_RUN);
    const stringerAngle = Math.atan2(TOTAL_HEIGHT - 0.10, TOTAL_RUN);
    const midY = TOTAL_HEIGHT * 0.5;
    const midZ = (1.30 + (landingZ + LANDING_DEPTH * 0.45)) * 0.5;

    for (const s of [-1, 1]) {
        const sx = s * (STAIR_WIDTH * 0.5 + 0.05);
        addPart(group, new THREE.BoxGeometry(0.14, 0.28, stringerLen), matRustyFrame, sx, midY, midZ, stringerAngle, 0, 0);
        addPart(group, new THREE.BoxGeometry(0.06, 0.16, stringerLen - 0.12), matDesertArmor, sx + s * 0.05, midY, midZ, stringerAngle, 0, 0);
        addPart(group, new THREE.BoxGeometry(0.26, 0.12, 0.36), matDarkFrame, sx, 0.06, 1.28);
    }

    const NUM_STEPS = 10;
    const zStart = 1.26;
    const zEnd = landingZ + LANDING_DEPTH * 0.42;
    for (let i = 0; i < NUM_STEPS; i++) {
        const t = (i + 0.5) / NUM_STEPS;
        const stepY = 0.16 + t * (TOTAL_HEIGHT - 0.24);
        const stepZ = zStart + t * (zEnd - zStart);

        addPart(group, new THREE.BoxGeometry(STAIR_WIDTH - 0.02, 0.06, 0.26), matDeckGrate, 0, stepY, stepZ);
        addPart(group, new THREE.BoxGeometry(STAIR_WIDTH - 0.04, 0.05, 0.04), matHazardStripe, 0, stepY + 0.005, stepZ + 0.12);

        for (const s of [-1, 1]) {
            addPart(group, new THREE.BoxGeometry(0.08, 0.14, 0.22), matDarkFrame, s * (STAIR_WIDTH * 0.5 - 0.04), stepY - 0.06, stepZ);
            if (!withRailings) {
                addPart(group, new THREE.BoxGeometry(0.04, 0.08, 0.26), matDesertArmor, s * (STAIR_WIDTH * 0.5 + 0.01), stepY + 0.04, stepZ);
            }
        }
    }

    if (!withRailings) {
        for (const s of [-1, 1]) {
            const rx = s * (STAIR_WIDTH * 0.5 + 0.04);
            addPart(group, new THREE.BoxGeometry(0.08, 0.14, LANDING_DEPTH * 0.92), matDesertArmor, rx, TOTAL_HEIGHT + 0.07, landingZ);
        }
        return group;
    }

    const railHeight = 0.92;
    for (const s of [-1, 1]) {
        const rx = s * (STAIR_WIDTH * 0.5 + 0.05);
        const posts: Array<[number, number]> = [
            [1.28, 0.12],
            [(1.28 + landingZ + 0.34) * 0.5, TOTAL_HEIGHT * 0.52],
            [landingZ + 0.34, TOTAL_HEIGHT],
            [landingZ - 0.38, TOTAL_HEIGHT]
        ];
        for (const [pz, py] of posts) {
            addPart(group, new THREE.BoxGeometry(0.06, railHeight, 0.06), matDarkFrame, rx, py + railHeight * 0.5, pz);
            addPart(group, new THREE.BoxGeometry(0.12, 0.10, 0.12), matRustyFrame, rx, py + 0.05, pz);
        }
        addPart(group, new THREE.BoxGeometry(0.07, 0.07, stringerLen * 0.98), matDesertArmor, rx, midY + railHeight, midZ, stringerAngle, 0, 0);
        addPart(group, new THREE.BoxGeometry(0.04, 0.05, stringerLen * 0.96), matRustyFrame, rx, midY + railHeight * 0.52, midZ, stringerAngle, 0, 0);

        addPart(group, new THREE.BoxGeometry(0.07, 0.07, LANDING_DEPTH * 0.86), matDesertArmor, rx, TOTAL_HEIGHT + railHeight, landingZ - 0.02);
        addPart(group, new THREE.BoxGeometry(0.04, 0.05, LANDING_DEPTH * 0.84), matRustyFrame, rx, TOTAL_HEIGHT + railHeight * 0.52, landingZ - 0.02);
    }

    return group;
}

export function createPrefabModel(type: PieceType, mats = getBuildingMaterials()): THREE.Group {
    switch (type) {
        case 'foundation':
            return createFoundationModel(mats);
        case 'solid_wall':
            return createSolidWallModel(mats);
        case 'window_wall':
            return createWindowWallModel(mats);
        case 'door_wall':
            return createDoorWallModel(mats);
        case 'ceiling':
            return createCeilingModel(mats);
        case 'staircase_railed':
            return createStaircaseModel(true, mats);
        case 'staircase_open':
            return createStaircaseModel(false, mats);
    }
}

export interface BakedPrefabAsset {
    type: PieceType;
    geometry: THREE.BufferGeometry;
    materials: THREE.Material[];
}

// Сливает массив индексированных геометрий с группами по материалам в одну BufferGeometry
// для использования в THREE.InstancedMesh(geometry, materials, maxCount)
function bakeGroupToMultiMaterialGeometry(root: THREE.Group): {
    geometry: THREE.BufferGeometry;
    materials: THREE.Material[];
} {
    root.updateMatrixWorld(true);

    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const materialOrder: THREE.Material[] = [];

    root.traverse(obj => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!mat) return;

        const cloned = mesh.geometry.clone();
        cloned.applyMatrix4(mesh.matrixWorld);

        if (!byMaterial.has(mat)) {
            byMaterial.set(mat, []);
            materialOrder.push(mat);
        }
        byMaterial.get(mat)!.push(cloned);
    });

    let totalVerts = 0;
    let totalIndices = 0;

    const preparedBuckets: Array<{
        mat: THREE.Material;
        geoms: THREE.BufferGeometry[];
        bucketIndicesCount: number;
    }> = [];

    for (const mat of materialOrder) {
        const geoms = byMaterial.get(mat)!;
        let bucketIndicesCount = 0;
        for (const g of geoms) {
            const pos = g.getAttribute('position');
            totalVerts += pos.count;
            const idx = g.getIndex();
            const count = idx ? idx.count : pos.count;
            totalIndices += count;
            bucketIndicesCount += count;
        }
        preparedBuckets.push({ mat, geoms, bucketIndicesCount });
    }

    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);
    const indices = new Uint32Array(totalIndices);

    const merged = new THREE.BufferGeometry();
    let vertOffset = 0;
    let indexOffset = 0;

    for (let matIdx = 0; matIdx < preparedBuckets.length; matIdx++) {
        const { geoms, bucketIndicesCount } = preparedBuckets[matIdx];
        const groupStart = indexOffset;

        for (const g of geoms) {
            const posAttr = g.getAttribute('position');
            const normAttr = g.getAttribute('normal');
            const uvAttr = g.getAttribute('uv');
            const vCount = posAttr.count;

            for (let i = 0; i < vCount; i++) {
                const p3 = (vertOffset + i) * 3;
                positions[p3] = posAttr.getX(i);
                positions[p3 + 1] = posAttr.getY(i);
                positions[p3 + 2] = posAttr.getZ(i);

                if (normAttr) {
                    normals[p3] = normAttr.getX(i);
                    normals[p3 + 1] = normAttr.getY(i);
                    normals[p3 + 2] = normAttr.getZ(i);
                }
                if (uvAttr) {
                    const p2 = (vertOffset + i) * 2;
                    uvs[p2] = uvAttr.getX(i);
                    uvs[p2 + 1] = uvAttr.getY(i);
                }
            }

            const idxAttr = g.getIndex();
            if (idxAttr) {
                for (let i = 0; i < idxAttr.count; i++) {
                    indices[indexOffset + i] = idxAttr.getX(i) + vertOffset;
                }
                indexOffset += idxAttr.count;
            } else {
                for (let i = 0; i < vCount; i++) {
                    indices[indexOffset + i] = vertOffset + i;
                }
                indexOffset += vCount;
            }

            vertOffset += vCount;
            g.dispose();
        }

        merged.addGroup(groupStart, bucketIndicesCount, matIdx);
    }

    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    merged.setIndex(new THREE.BufferAttribute(indices, 1));
    merged.computeBoundingBox();
    merged.computeBoundingSphere();

    return {
        geometry: merged,
        materials: materialOrder
    };
}

const _bakedAssetsCache = new Map<PieceType, BakedPrefabAsset>();
let _bakedDoorFrameAsset: BakedPrefabAsset | null = null;
let _bakedDoorLeafAsset: BakedPrefabAsset | null = null;

export function getBakedPrefabAsset(type: PieceType, isSoftwareGl = false): BakedPrefabAsset {
    const cached = _bakedAssetsCache.get(type);
    if (cached) return cached;

    const mats = getBuildingMaterials(isSoftwareGl);
    const group = createPrefabModel(type, mats);
    const { geometry, materials } = bakeGroupToMultiMaterialGeometry(group);
    const asset: BakedPrefabAsset = { type, geometry, materials };
    _bakedAssetsCache.set(type, asset);
    return asset;
}

export function getBakedDoorFrameAsset(isSoftwareGl = false): BakedPrefabAsset {
    if (_bakedDoorFrameAsset) return _bakedDoorFrameAsset;
    const mats = getBuildingMaterials(isSoftwareGl);
    const group = createDoorFrameModel(mats);
    const { geometry, materials } = bakeGroupToMultiMaterialGeometry(group);
    _bakedDoorFrameAsset = { type: 'door_wall', geometry, materials };
    return _bakedDoorFrameAsset;
}

export function getBakedDoorLeafAsset(isSoftwareGl = false): BakedPrefabAsset {
    if (_bakedDoorLeafAsset) return _bakedDoorLeafAsset;
    const mats = getBuildingMaterials(isSoftwareGl);
    const group = createDoorLeafModel(mats);
    const { geometry, materials } = bakeGroupToMultiMaterialGeometry(group);
    _bakedDoorLeafAsset = { type: 'door_wall', geometry, materials };
    return _bakedDoorLeafAsset;
}

export function clearBakedPrefabCache(): void {
    for (const asset of _bakedAssetsCache.values()) {
        asset.geometry.dispose();
    }
    _bakedAssetsCache.clear();
    if (_bakedDoorFrameAsset) {
        _bakedDoorFrameAsset.geometry.dispose();
        _bakedDoorFrameAsset = null;
    }
    if (_bakedDoorLeafAsset) {
        _bakedDoorLeafAsset.geometry.dispose();
        _bakedDoorLeafAsset = null;
    }
    if (_sharedMaterials) {
        _sharedMaterials.dispose();
    }
}
