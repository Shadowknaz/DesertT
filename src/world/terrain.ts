// Один чанк-диорама: деформируемый меш песка, карта типов пустынных почв (aSoilMask),
// физический heightfield и геологический «срез» породы по открытым сторонам.
import * as THREE from 'three';
import { RAPIER } from './physics.ts';
import { CHUNK, DIORAMA, TERRAIN } from '../config.ts';
import { getDuneHeight, getDuneNormal, getBiomeWeights, smoothAndErodeHeightmap, type BiomeWeights } from '../core/duneField.ts';
import { fbmSimplex, simplexNoise, smoothstep } from '../core/noise.ts';

export interface SoilSurfaceMask {
    bareRock: number;     // 0..1 обнажённая скальная порода и осадочные уступы
    gravelReg: number;    // 0..1 каменистая почва Рег (щебень, галька, гравийный панцирь)
    hardpanPlain: number; // 0..1 растрескавшаяся глинисто-солончаковая корка (такыр)
}

const _biomeScratch: BiomeWeights = {
    sandWeight: 0,
    duneWeight: 0,
    plainWeight: 0,
    rockWeight: 0,
    canyonWeight: 0,
    erg: 0,
    reg: 0,
    mesa: 0,
    classic: 0
};
const _soilScratch: SoilSurfaceMask = {
    bareRock: 0,
    gravelReg: 0,
    hardpanPlain: 0
};
const _normalScratch = new THREE.Vector3();
let _rawHeightsScratch = new Float32Array(0);

// Вычисляет локальные веса типов поверхности пустыни в мировых координатах (worldX, worldZ)
// для вершинного атрибута aSoilMask, раскраски рельефа и спавна мелкой гальки/плитняка.
export function computeSoilWeightsAt(
    worldX: number,
    worldZ: number,
    h: number,
    slope: number,
    wideLaplacian: number = 0.0,
    precomputedBiomes?: BiomeWeights,
    out?: SoilSurfaceMask
): SoilSurfaceMask {
    const biomes = precomputedBiomes || getBiomeWeights(worldX, worldZ, _biomeScratch);

    // 1. Обнажённая порода: крутые склоны, стены каньонов, вершины холмов и локальные выходы плитняка
    const slopeStart = TERRAIN.rockSlopeStart * (
        1.0 + (biomes.sandWeight + biomes.duneWeight) * 0.30 -
        (biomes.rockWeight + biomes.canyonWeight) * 0.30
    );
    const rockBySlope = smoothstep(slopeStart, TERRAIN.rockSlopeFull, slope);
    const rockByHeight = smoothstep(
        TERRAIN.rockLineStart,
        TERRAIN.rockLineFull,
        h
    ) * (0.38 + biomes.rockWeight * 0.58);
    const canyonWallRock = biomes.canyonWeight * smoothstep(0.16, 0.48, slope) * 0.88;

    // Небольшие скальные выходы коренной породы на перегибах рельефа
    const outcropNoise = simplexNoise(worldX * 0.048 + 31.2, worldZ * 0.048 - 19.4);
    const localOutcrop = smoothstep(0.56, 0.84, outcropNoise) *
        smoothstep(0.10, 0.32, slope) *
        (0.35 + biomes.rockWeight * 0.65 + biomes.plainWeight * 0.30);

    let bareRock = Math.min(1.0, Math.max(rockBySlope, rockByHeight, canyonWallRock, localOutcrop));
    bareRock *= (1.0 - (biomes.sandWeight * 0.45 + biomes.duneWeight * 0.40) * (1.0 - rockBySlope));

    // 2. Каменистая почва Рег (галька, щебень, гравийный панцирь):
    // образуется в междюнных ложбинах (где ветер выдувает мелкий песок, wideLaplacian > 0),
    // у подножий холмов и связными пятнами на пустынных равнинах.
    const regPatchMacro = fbmSimplex(worldX * 0.028 - 14.3, worldZ * 0.028 + 22.7, 2, 2.0, 0.45);
    const regPatchMeso = simplexNoise(worldX * 0.075 + 7.4, worldZ * 0.075 - 11.8);
    const deflationHollow = smoothstep(-0.02, 0.14, wideLaplacian);
    const regSignal =
        biomes.rockWeight * 0.72 +
        biomes.plainWeight * 0.42 +
        biomes.canyonWeight * 0.35 +
        deflationHollow * 0.32 +
        regPatchMacro * 0.38 +
        regPatchMeso * 0.18;

    let gravelReg = smoothstep(0.18, 0.62, regSignal) * (1.0 - bareRock * 0.80);

    // 3. Такырная растрескавшаяся корка (hardpan):
    // в плоских сухих низинах и на спокойных равнинах при малом уклоне
    const takyrNoise = simplexNoise(worldX * 0.034 + 51.0, worldZ * 0.034 + 17.0);
    const flatMask = 1.0 - smoothstep(0.06, 0.22, slope);
    const takyrSignal =
        (biomes.plainWeight * 0.75 + biomes.sandWeight * 0.28) *
        flatMask *
        smoothstep(0.08, 0.64, takyrNoise + deflationHollow * 0.35);

    const hardpanPlain = Math.min(1.0, takyrSignal * (1.0 - bareRock) * (1.0 - gravelReg * 0.55));

    const br = Math.min(1.0, Math.max(0.0, bareRock));
    const gr = Math.min(1.0, Math.max(0.0, gravelReg));
    const hp = Math.min(1.0, Math.max(0.0, hardpanPlain));
    if (out) {
        out.bareRock = br;
        out.gravelReg = gr;
        out.hardpanPlain = hp;
        return out;
    }
    return {
        bareRock: br,
        gravelReg: gr,
        hardpanPlain: hp
    };
}

interface WallSide {
    key: 'nz' | 'pz' | 'nx' | 'px';
    reversed: boolean;
    indexAt: (n: number, s: number) => number;
}

// Четыре кромки чанка. Индексы вершин соответствуют PlaneGeometry
// (col = x, row = z), а reversed задает обход, при котором нормаль
// стенки смотрит наружу чанка.
const WALL_SIDES: WallSide[] = [
    { key: 'nz', reversed: true, indexAt: (n, s) => s },
    { key: 'pz', reversed: false, indexAt: (n, s) => n * (n + 1) + s },
    { key: 'nx', reversed: false, indexAt: (n, s) => s * (n + 1) },
    { key: 'px', reversed: true, indexAt: (n, s) => s * (n + 1) + n }
];

// Стенка среза: кромка песка экструдируется вниз до baseBottom.
function buildWall(
    positionAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    segments: number,
    side: WallSide,
    material: THREE.Material
): THREE.Mesh {
    const vertices: number[] = [];
    const colors: number[] = [];
    const bottomY = DIORAMA.baseBottom;

    for (let s = 0; s < segments; s++) {
        const i1 = side.indexAt(segments, s);
        const i2 = side.indexAt(segments, s + 1);

        const v1 = [positionAttribute.getX(i1), positionAttribute.getY(i1), positionAttribute.getZ(i1)];
        const v2 = [positionAttribute.getX(i2), positionAttribute.getY(i2), positionAttribute.getZ(i2)];
        const v3 = [v1[0], bottomY, v1[2]];
        const v4 = [v2[0], bottomY, v2[2]];

        const pushVert = (v: number[], isBottom: boolean): void => {
            vertices.push(v[0], v[1], v[2]);
            if (isBottom) {
                colors.push(0.42, 0.31, 0.24);
            } else {
                colors.push(0.96, 0.86, 0.72);
            }
        };

        if (!side.reversed) {
            pushVert(v1, false); pushVert(v3, true); pushVert(v2, false);
            pushVert(v2, false); pushVert(v3, true); pushVert(v4, true);
        } else {
            pushVert(v1, false); pushVert(v2, false); pushVert(v3, true);
            pushVert(v2, false); pushVert(v4, true); pushVert(v3, true);
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

export interface ChunkTerrainOptions {
    scene: THREE.Scene;
    world: any;
    cx: number;
    cz: number;
    sandMaterial: THREE.Material;
    skirtMaterial: THREE.Material;
    frameMaterial: THREE.Material;
    frameGeometry: THREE.BufferGeometry;
}

export interface OpenEdges {
    nx: boolean;
    px: boolean;
    nz: boolean;
    pz: boolean;
}

export interface ChunkTerrain {
    sandMesh: THREE.Mesh;
    sandGeometry: THREE.PlaneGeometry;
    positionAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    colorAttribute: THREE.BufferAttribute;
    soilMaskAttribute: THREE.BufferAttribute;
    syncPhysics(delta: ArrayLike<number> | null): boolean;
    setOpenEdges(open: OpenEdges): void;
    getHeights(): Float32Array;
    dispose(): void;
}

export function createChunkTerrain({
    scene,
    world,
    cx,
    cz,
    sandMaterial,
    skirtMaterial,
    frameMaterial,
    frameGeometry
}: ChunkTerrainOptions): ChunkTerrain {
    const size = CHUNK.size;
    const segments = CHUNK.gridSegments;
    const n = segments + 1;
    const originX = cx * size;
    const originZ = cz * size;

    const sandGeometry = new THREE.PlaneGeometry(size, size, segments, segments);
    sandGeometry.rotateX(-Math.PI / 2);

    const positionAttribute = sandGeometry.attributes.position;
    const colorAttribute = new THREE.BufferAttribute(new Float32Array(positionAttribute.count * 3), 3);
    const soilMaskAttribute = new THREE.BufferAttribute(new Float32Array(positionAttribute.count * 4), 4);
    sandGeometry.setAttribute('color', colorAttribute);
    sandGeometry.setAttribute('aSoilMask', soilMaskAttribute);

    // Массив высот для Rapier Heightfield (column-major)
    const heights = new Float32Array(n * n);
    const step = size / segments;
    const half = size * 0.5;

    for (let row = 0; row <= segments; row++) {
        const worldZ = originZ + row * step - half;
        for (let col = 0; col <= segments; col++) {
            const worldX = originX + col * step - half;
            heights[row + col * n] = getDuneHeight(worldX, worldZ);
        }
    }

    if (_rawHeightsScratch.length < heights.length) {
        _rawHeightsScratch = new Float32Array(heights.length);
    }
    _rawHeightsScratch.set(heights);

    // Дополнительный сеточный проход селективного сглаживания и эрозии внутри чанка
    // (сохраняет точные высоты на границах для бесшовной стыковки соседних чанков)
    smoothAndErodeHeightmap(heights, segments, originX, originZ, size, 2);

    for (let row = 0; row <= segments; row++) {
        const rowOffset = row * n;
        for (let col = 0; col <= segments; col++) {
            positionAttribute.setY(rowOffset + col, heights[row + col * n]);
        }
    }

    // Аналитический рельеф как эталон: поле песка хранит смещение от него,
    // и высотное поле физики пересобирается как base + delta.
    const baseHeights = new Float32Array(heights);

    // Высота вершины сетки. За кромкой чанка берется мировая высота: иначе
    // односторонняя разность дала бы шов цвета на стыке с соседним чанком.
    function heightAt(col: number, row: number): number {
        if (col >= 0 && col <= segments && row >= 0 && row <= segments) {
            return heights[row + col * n];
        }
        return getDuneHeight(originX + col * step - half, originZ + row * step - half);
    }

    // Окраска вершин и заполнение маски типов почв (aSoilMask):
    // золотисто-янтарный песок на гребнях дюн, более глубокая теплая охра во впадинах,
    // каменисто-щебнистая почва Рег, выбеленные такырные плеши и слоистая терракотовая порода.
    for (let row = 0; row <= segments; row++) {
        const worldZ = originZ + row * step - half;
        const rowOffset = row * n;
        for (let col = 0; col <= segments; col++) {
            const i = rowOffset + col;
            const h = heights[row + col * n];
            const worldX = originX + col * step - half;
            const biomes = getBiomeWeights(worldX, worldZ, _biomeScratch);

            const hL = heightAt(col - 2, row);
            const hR = heightAt(col + 2, row);
            const hD = heightAt(col, row - 2);
            const hU = heightAt(col, row + 2);

            const span = 4 * step;
            const gx = (hR - hL) / span;
            const gz = (hU - hD) / span;
            const slope = Math.hypot(gx, gz);

            // Кривизна рельефа: междюнные впадины и днища каньонов слегка затеняются,
            // а гребни барханов и уступов получают теплый солнечный отсвет.
            const wideLaplacian = (hL + hR + hD + hU - 4.0 * h) / (span * span);
            const ao = Math.min(0.14, Math.max(-0.11, wideLaplacian * 0.28));
            const aoMul = 1.0 - ao;

            const soil = computeSoilWeightsAt(worldX, worldZ, h, slope, wideLaplacian, biomes, _soilScratch);
            const bare = soil.bareRock;
            const gravel = soil.gravelReg;
            const hardpan = soil.hardpanPlain;

            soilMaskAttribute.setXYZW(i, bare, gravel, hardpan, 0.0);

            // Горизонтальная осадочная стратификация на стенах каньонов и каменистых уступах
            const strataWeight = biomes.canyonWeight * 0.90 + biomes.rockWeight * 0.45 + bare * 0.55;
            const strata = strataWeight > 0.03
                ? (Math.sin(h * 2.1) * 0.062 + Math.sin(h * 5.4) * 0.028) * Math.min(1.0, strataWeight)
                : 0.0;

            // Природная вариация минерального тона (кварцевый песок / железистая охра / темный щебень)
            const macroTint = fbmSimplex(worldX * 0.022 + 8.0, worldZ * 0.022 - 5.0, 2, 2.0, 0.45) * 0.055;
            const mesoTint = simplexNoise(worldX * 0.085 - 17.0, worldZ * 0.085 + 11.0) * 0.032;
            const heightTint = smoothstep(-4.0, 14.0, h);

            // Песок: тёплое золотистое море с выраженным переходом между гребнями и ложбинами
            const sandR = Math.min(1.12, Math.max(0.72,
                0.93 + heightTint * 0.07 +
                biomes.duneWeight * 0.05 +
                hardpan * 0.05 -
                gravel * 0.09 +
                macroTint + mesoTint
            ));
            const sandG = sandR * (0.945 - gravel * 0.035 + hardpan * 0.02);
            const sandB = sandR * (0.835 - gravel * 0.045 + hardpan * 0.035);

            // Каменистая порода и стены каньонов: сухая терракотово-бурая охра со слоями
            const rock = 0.52 + Math.min(0.14, slope * 0.09) + heightTint * 0.05 +
                strata + macroTint * 1.35;
            const rockGreen = rock * (0.70 - bare * 0.05 - biomes.canyonWeight * 0.04);
            const rockBlue = rock * (0.52 - bare * 0.05 - biomes.canyonWeight * 0.04);

            colorAttribute.setXYZ(
                i,
                (sandR + (rock - sandR) * bare) * aoMul,
                (sandG + (rockGreen - sandG) * bare) * aoMul,
                (sandB + (rockBlue - sandB) * bare) * aoMul
            );
        }
    }

    // Аналитические нормали не зависят от диагоналей треугольников сетки:
    // на границах чанка используется точный мировой вызов getDuneNormal для бесшовности,
    // а внутри чанка — центральные разности по предвычисленной аналитической сетке.
    const normalAttribute = sandGeometry.attributes.normal as THREE.BufferAttribute;
    const borderEps = Math.max(0.25, step * 0.75);
    const twoStep = 2.0 * step;
    for (let row = 0; row <= segments; row++) {
        const rowOffset = row * n;
        const worldZ = originZ + row * step - half;
        const isBorderRow = row === 0 || row === segments;
        for (let col = 0; col <= segments; col++) {
            const i = rowOffset + col;
            if (isBorderRow || col === 0 || col === segments) {
                const worldX = originX + col * step - half;
                getDuneNormal(worldX, worldZ, borderEps, _normalScratch);
                normalAttribute.setXYZ(i, _normalScratch.x, _normalScratch.y, _normalScratch.z);
            } else {
                const hXPos = _rawHeightsScratch[row + (col + 1) * n];
                const hXNeg = _rawHeightsScratch[row + (col - 1) * n];
                const hZPos = _rawHeightsScratch[(row + 1) + col * n];
                const hZNeg = _rawHeightsScratch[(row - 1) + col * n];
                const nx = hXNeg - hXPos;
                const nz = hZNeg - hZPos;
                const invLen = 1.0 / Math.hypot(nx, twoStep, nz);
                normalAttribute.setXYZ(i, nx * invLen, twoStep * invLen, nz * invLen);
            }
        }
    }
    normalAttribute.needsUpdate = true;

    const sandMesh = new THREE.Mesh(sandGeometry, sandMaterial);
    sandMesh.position.set(originX, 0, originZ);
    sandMesh.receiveShadow = true;
    sandMesh.updateMatrixWorld();
    scene.add(sandMesh);

    // Физический коллайдер песка чанка
    const groundBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(originX, 0, originZ)
    );
    const collider = world.createCollider(
        RAPIER.ColliderDesc.heightfield(segments, segments, heights, { x: size, y: 1.0, z: size })
            .setFriction(0.9)
            .setRestitution(0.05),
        groundBody
    );

    // Локальная деформация песка должна менять и физический рельеф:
    // иначе корпус и обломки сталкиваются со старым, недеформированным
    // heightfield, пока меш и лапы уже видят воронку.
    let disposed = false;
    function syncPhysics(delta: ArrayLike<number> | null): boolean {
        if (!delta || disposed) return false;

        let dirty = false;
        for (let row = 0; row <= segments; row++) {
            const rowOffset = row * n;
            for (let col = 0; col <= segments; col++) {
                const i = rowOffset + col;
                const index = row + col * n;
                const nextH = baseHeights[index] + delta[i];
                if (Math.abs(heights[index] - nextH) > 1e-5) {
                    heights[index] = nextH;
                    dirty = true;
                }
            }
        }

        if (!dirty) return false;

        collider.setShape(new RAPIER.Heightfield(
            segments, segments, heights, { x: size, y: 1.0, z: size }
        ));
        if (typeof (world as any).updateSceneQueries === 'function') {
            (world as any).updateSceneQueries();
        }
        return true;
    }

    // Стенки среза тоже локальны; показываются только там, где нет соседа.
    const walls: Record<string, THREE.Mesh> = {};
    WALL_SIDES.forEach(side => {
        const wall = buildWall(positionAttribute, segments, side, skirtMaterial);
        wall.position.set(originX, 0, originZ);
        wall.updateMatrixWorld();
        scene.add(wall);
        walls[side.key] = wall;
    });

    const frameMesh = new THREE.Mesh(frameGeometry, frameMaterial);
    frameMesh.position.set(originX, DIORAMA.baseBottom - 0.5, originZ);
    scene.add(frameMesh);

    // Открытая сторона — та, за которой чанк еще не загружен.
    function setOpenEdges(open: OpenEdges): void {
        walls.nx.visible = open.nx;
        walls.px.visible = open.px;
        walls.nz.visible = open.nz;
        walls.pz.visible = open.pz;
        frameMesh.visible = open.nx || open.px || open.nz || open.pz;
    }

    function dispose(): void {
        disposed = true;
        scene.remove(sandMesh);
        sandGeometry.dispose();

        WALL_SIDES.forEach(side => {
            const wall = walls[side.key];
            scene.remove(wall);
            wall.geometry.dispose();
        });

        scene.remove(frameMesh);
        world.removeRigidBody(groundBody);
    }

    return {
        sandMesh,
        sandGeometry,
        positionAttribute,
        colorAttribute,
        soilMaskAttribute,
        syncPhysics,
        setOpenEdges,
        getHeights: () => heights,
        dispose
    };
}
