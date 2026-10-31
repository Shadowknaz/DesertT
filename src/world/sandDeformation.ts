// Песок: слой визуализации поверх активного поля.
// Переписывает вершины меша (включая частичные dirty-подобласти),
// красит воронки, своевременно обновляет физические heightfield Rapier
// и раздаёт шину событий: отпечаток лапы, удар по песку и клик.
import * as THREE from 'three';
import { CHUNK, SANDFIELD } from '../config.ts';
import { chunkCoordAt, chunkKeyOf } from '../core/chunkCoords.ts';

const DEFAULT_PACKING = 0.12;
const SEG = CHUNK.gridSegments;
const N = SEG + 1;
const CELL = CHUNK.size / SEG;

export interface ChunkPhysicsSync {
    syncPhysics(delta: Float32Array): void;
}

export interface AttachedChunkRecord {
    geometry: THREE.BufferGeometry;
    position: THREE.BufferAttribute;
    color: THREE.BufferAttribute | null;
    baseY: Float32Array;
    baseColor: Float32Array | null;
    // Нормали аналитического рельефа до локальных деформаций. Они нужны как
    // базис для мирового пересчёта: нормаль на кромке должна видеть соседний
    // чанк, а не замыкаться на последнюю строку текущего меша.
    baseNormal: Float32Array | null;
    originX: number;
    originZ: number;
    physics: ChunkPhysicsSync | null;
}

export interface SandDeformerOptions {
    field: any;
}

export interface SandDeformer {
    attachChunk(key: string, geometry: THREE.BufferGeometry, originX: number, originZ: number, physics?: ChunkPhysicsSync | null): void;
    detachChunk(key: string): void;
    stampFootprint(worldPos: THREE.Vector3, radius?: number, depth?: number): number;
    syncPhysicsAt(x: number, z: number, radius?: number): void;
    sampleDepth(x: number, z: number): number;
    update(dt: number, weather?: { windX: number; windZ: number; erosionRate: number } | null): number;
    getAttachedCount(): number;
    dispose(): void;
}

export function createSandDeformer({ field }: SandDeformerOptions): SandDeformer {
    // key -> { geometry, position, color, baseY, baseColor, baseNormal, originX, originZ, physics }
    const attached = new Map<string, AttachedChunkRecord>();

    // Пересчитывает нормали в мировых координатах. `sampleNormal` берёт
    // градиент деформации по обе стороны точки и тем самым корректно
    // пересекает границу чанка. Аналитическая нормаль остаётся базисом,
    // поэтому при нулевой деформации соседние меши получают одинаковый свет.
    function refreshNormals(
        rec: AttachedChunkRecord,
        minRow: number,
        maxRow: number,
        minCol: number,
        maxCol: number
    ): void {
        const normal = rec.geometry.attributes.normal as THREE.BufferAttribute | undefined;
        const baseNormal = rec.baseNormal;
        if (!normal || !baseNormal) return;

        const out = new THREE.Vector3();
        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                const i = r * N + c;
                const base = {
                    x: baseNormal[i * 3],
                    y: baseNormal[i * 3 + 1],
                    z: baseNormal[i * 3 + 2]
                };
                const worldX = rec.originX + rec.position.getX(i);
                const worldZ = rec.originZ + rec.position.getZ(i);
                if (typeof field.sampleNormal === 'function') {
                    field.sampleNormal(worldX, worldZ, base, out);
                    normal.setXYZ(i, out.x, out.y, out.z);
                } else {
                    // Совместимость с минимальными тестовыми полями без
                    // sampleNormal: внутри чанка сохраняем старый fallback.
                    const cL = Math.max(0, c - 1);
                    const cR = Math.min(SEG, c + 1);
                    const rD = Math.max(0, r - 1);
                    const rU = Math.min(SEG, r + 1);
                    const yL = rec.position.getY(r * N + cL);
                    const yR = rec.position.getY(r * N + cR);
                    const yD = rec.position.getY(rD * N + c);
                    const yU = rec.position.getY(rU * N + c);
                    const dx = (yR - yL) / ((cR - cL) * CELL || 1);
                    const dz = (yU - yD) / ((rU - rD) * CELL || 1);
                    const len = Math.hypot(-dx, 1.0, -dz) || 1.0;
                    normal.setXYZ(i, -dx / len, 1.0 / len, -dz / len);
                }
            }
        }
        normal.needsUpdate = true;
    }

    function flushRegion(rec: AttachedChunkRecord, grid: any, bounds: { minRow: number; maxRow: number; minCol: number; maxCol: number }): void {
        const position = rec.position;
        const color = rec.color;
        const baseColor = rec.baseColor;
        const baseY = rec.baseY;
        const delta = grid.delta;
        const packing = grid.packing;
        const slipX = grid.slipX;
        const slipZ = grid.slipZ;

        const minR = Math.max(0, bounds.minRow - 1);
        const maxR = Math.min(SEG, bounds.maxRow + 1);
        const minC = Math.max(0, bounds.minCol - 1);
        const maxC = Math.min(SEG, bounds.maxCol + 1);

        for (let r = minR; r <= maxR; r++) {
            for (let c = minC; c <= maxC; c++) {
                const i = r * N + c;
                const d = delta[i];
                position.setY(i, baseY[i] + d);

                if (color && baseColor) {
                    const shade = Math.min(0.4, Math.max(-0.45, d * SANDFIELD.colorGain));
                    const pack = packing ? packing[i] * 0.05 : 0;
                    const shear = slipX ? Math.min(0.08, Math.hypot(slipX[i], slipZ[i]) * 0.06) : 0;
                    const k = 1 + shade - pack + shear;
                    color.setXYZ(i, baseColor[i * 3] * k, baseColor[i * 3 + 1] * k, baseColor[i * 3 + 2] * k);
                }
            }
        }

        refreshNormals(rec, minR, maxR, minC, maxC);

        position.needsUpdate = true;
        if (color) color.needsUpdate = true;
        if (rec.physics) rec.physics.syncPhysics(delta);
    }

    function flushChunk(key: string): boolean {
        const rec = attached.get(key);
        if (!rec) return false;

        const grid = field.getRecord(key);
        const position = rec.position;
        const color = rec.color;
        const baseColor = rec.baseColor;
        const baseY = rec.baseY;
        const delta = grid ? grid.delta : null;
        const packing = grid ? grid.packing : null;
        const slipX = grid ? grid.slipX : null;
        const slipZ = grid ? grid.slipZ : null;
        if (!baseY || !delta) return false;

        const bounds = field.getDirtyBounds ? field.getDirtyBounds(key) : null;
        if (bounds && SANDFIELD.subregionMeshUpdate) {
            flushRegion(rec, grid, bounds);
            return true;
        }

        for (let i = 0; i < position.count; i++) {
            const d = delta[i];
            position.setY(i, baseY[i] + d);

            if (color && baseColor) {
                const shade = Math.min(0.4, Math.max(-0.45, d * SANDFIELD.colorGain));
                const pack = packing ? packing[i] * 0.05 : 0;
                const shear = slipX ? Math.min(0.08, Math.hypot(slipX[i], slipZ[i]) * 0.06) : 0;
                const k = 1 + shade - pack + shear;
                color.setXYZ(i, baseColor[i * 3] * k, baseColor[i * 3 + 1] * k, baseColor[i * 3 + 2] * k);
            }
        }

        position.needsUpdate = true;
        if (color) color.needsUpdate = true;
        refreshNormals(rec, 0, SEG, 0, SEG);

        if (rec.physics) rec.physics.syncPhysics(delta);
        return true;
    }

    function attachChunk(key: string, geometry: THREE.BufferGeometry, originX: number, originZ: number, physics: ChunkPhysicsSync | null = null): void {
        const position = geometry.attributes.position as THREE.BufferAttribute;
        const color = (geometry.attributes.color as THREE.BufferAttribute) || null;
        const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;

        const baseY = new Float32Array(position.count);
        for (let i = 0; i < position.count; i++) baseY[i] = position.array[i * 3 + 1];

        const rec: AttachedChunkRecord = {
            geometry,
            position,
            color,
            baseY,
            baseColor: color ? new Float32Array(color.array) : null,
            baseNormal: normal ? new Float32Array(normal.array) : null,
            originX,
            originZ,
            physics
        };
        attached.set(key, rec);

        const cx = Math.round(originX / CHUNK.size);
        const cz = Math.round(originZ / CHUNK.size);
        field.attachChunk(cx, cz);

        if (geometry.boundingSphere) {
            geometry.boundingSphere.radius += SANDFIELD.maxDelta + 0.5;
        } else {
            geometry.computeBoundingSphere();
        }

        flushChunk(key);
    }

    function detachChunk(key: string): void {
        const rec = attached.get(key);
        attached.delete(key);
        if (!rec) return;
        field.detachChunk(
            Math.round(rec.originX / CHUNK.size),
            Math.round(rec.originZ / CHUNK.size)
        );
    }

    function stampFootprint(worldPos: THREE.Vector3, radius: number = 1.05, depth: number = 0.24): number {
        const displaced = field.stampCrater(
            worldPos.x, worldPos.z, radius, depth, DEFAULT_PACKING
        );
        syncPhysicsAt(worldPos.x, worldPos.z, radius * 1.3);
        return displaced;
    }

    function syncPhysicsAt(x: number, z: number, radius: number = 1.2): void {
        const c0x = chunkCoordAt(x - radius);
        const c1x = chunkCoordAt(x + radius);
        const c0z = chunkCoordAt(z - radius);
        const c1z = chunkCoordAt(z + radius);

        for (let cx = c0x; cx <= c1x; cx++) {
            for (let cz = c0z; cz <= c1z; cz++) {
                const key = chunkKeyOf(cx, cz);
                const rec = attached.get(key);
                if (!rec || !rec.physics) continue;
                const grid = field.getRecord(key);
                if (grid) rec.physics.syncPhysics(grid.delta);
            }
        }
    }

    function sampleDepth(x: number, z: number): number {
        return field.sampleDelta(x, z);
    }

    function update(dt: number, weather: { windX: number; windZ: number; erosionRate: number } | null = null): number {
        if (weather) {
            field.update(dt, {
                windX: weather.windX,
                windZ: weather.windZ,
                erosionRate: weather.erosionRate
            });
        } else {
            field.update(dt, { erosionRate: 0 });
        }

        // Своевременно обновляем физические коллайдеры Rapier для всех изменённых ветром чанков
        if (field.consumePhysicsDirty) {
            const physicsKeys = field.consumePhysicsDirty();
            for (let i = 0; i < physicsKeys.length; i++) {
                const rec = attached.get(physicsKeys[i]);
                if (rec && rec.physics) {
                    const grid = field.getRecord(physicsKeys[i]);
                    if (grid) rec.physics.syncPhysics(grid.delta);
                }
            }
        }

        const keys = field.consumeDirty(SANDFIELD.flushChunksPerFrame);
        for (let i = 0; i < keys.length; i++) flushChunk(keys[i]);
        return keys.length;
    }

    function getAttachedCount(): number {
        return attached.size;
    }

    function dispose(): void {
        attached.clear();
    }

    return {
        attachChunk,
        detachChunk,
        stampFootprint,
        syncPhysicsAt,
        sampleDepth,
        update,
        getAttachedCount,
        dispose
    };
}

