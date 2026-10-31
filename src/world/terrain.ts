// Один чанк-диорама: деформируемый меш песка, физический heightfield
// и «срез» породы по открытым сторонам, повторяющий профиль барханов.
import * as THREE from 'three';
import { RAPIER } from './physics.ts';
import { CHUNK, DIORAMA, TERRAIN } from '../config.ts';
import { getDuneHeight } from '../core/duneField.ts';
import { smoothstep } from '../core/noise.ts';

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
                colors.push(0.45, 0.35, 0.3);
            } else {
                colors.push(1.0, 0.92, 0.82);
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
    const originX = cx * size;
    const originZ = cz * size;

    const sandGeometry = new THREE.PlaneGeometry(size, size, segments, segments);
    sandGeometry.rotateX(-Math.PI / 2);

    const positionAttribute = sandGeometry.attributes.position;
    const colorAttribute = new THREE.BufferAttribute(new Float32Array(positionAttribute.count * 3), 3);
    sandGeometry.setAttribute('color', colorAttribute);

    // Массив высот для Rapier Heightfield (column-major)
    const heights = new Float32Array((segments + 1) * (segments + 1));
    const step = size / segments;
    const half = size * 0.5;

    for (let i = 0; i < positionAttribute.count; i++) {
        // Вершины меша локальны, высота — мировая, чтобы соседние чанки
        // сходились по кромке без швов.
        const worldX = positionAttribute.getX(i) + originX;
        const worldZ = positionAttribute.getZ(i) + originZ;
        const h = getDuneHeight(worldX, worldZ);
        positionAttribute.setY(i, h);

        const col = i % (segments + 1);
        const row = Math.floor(i / (segments + 1));
        heights[row + col * (segments + 1)] = h;
    }

    // Аналитический рельеф как эталон: поле песка хранит смещение от него,
    // и высотное поле физики пересобирается как base + delta.
    const baseHeights = new Float32Array(heights);

    // Высота вершины сетки. За кромкой чанка берется мировая высота: иначе
    // односторонняя разность дала бы шов цвета на стыке с соседним чанком.
    function heightAt(col: number, row: number): number {
        if (col >= 0 && col <= segments && row >= 0 && row <= segments) {
            return heights[row + col * (segments + 1)];
        }
        return getDuneHeight(originX + col * step - half, originZ + row * step - half);
    }

    // Цвет вершины: теплый песок на пологих склонах и голая порода на кручах
    // и высоких вершинах. Уклон считается по той же сетке высот, что у физики.
    for (let row = 0; row <= segments; row++) {
        for (let col = 0; col <= segments; col++) {
            const i = row * (segments + 1) + col;
            const h = heights[row + col * (segments + 1)];

            const gx = (heightAt(col + 1, row) - heightAt(col - 1, row)) / (2 * step);
            const gz = (heightAt(col, row + 1) - heightAt(col, row - 1)) / (2 * step);
            const slope = Math.hypot(gx, gz);

            const rockBySlope = smoothstep(TERRAIN.rockSlopeStart, TERRAIN.rockSlopeFull, slope);
            const rockByHeight = smoothstep(TERRAIN.rockLineStart, TERRAIN.rockLineFull, h) * 0.7;
            const bare = Math.min(1.0, Math.max(rockBySlope, rockByHeight));

            // Песок светлеет с высотой, порода уходит в темный красно-бурый
            const sand = Math.min(1.06, Math.max(0.7, 0.87 + h * 0.035));
            const rock = 0.56 + Math.min(0.12, slope * 0.06);

            colorAttribute.setXYZ(
                i,
                sand + (rock - sand) * bare,
                sand * 0.965 + (rock * 0.82 - sand * 0.965) * bare,
                sand * 0.92 + (rock * 0.68 - sand * 0.92) * bare
            );
        }
    }
    sandGeometry.computeVertexNormals();

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

        for (let i = 0; i < positionAttribute.count; i++) {
            const col = i % (segments + 1);
            const row = Math.floor(i / (segments + 1));
            const index = row + col * (segments + 1);
            heights[index] = baseHeights[index] + delta[i];
        }

        collider.setShape(new RAPIER.Heightfield(
            segments, segments, heights, { x: size, y: 1.0, z: size }
        ));
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
        syncPhysics,
        setOpenEdges,
        getHeights: () => heights,
        dispose
    };
}

