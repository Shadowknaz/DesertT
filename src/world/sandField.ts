// Активное поле песка (L1): единственный источник правды о поверхности
// в локальной зоне. Сетка поля совпадает с сеткой меша чанка (65 x 65 узлов
// при шаге 0.47 м), поэтому высота, которую чувствуют лапы и пробники, — та же
// самая, что рисуется. Для каждой ячейки хранятся:
//
//   delta    смещение поверхности относительно аналитического рельефа, м
//   packing  уплотнение 0..1: чем плотнее, тем выше несущая способность
//   slipX/Z  скорость поверхностного сдвига песка, м/с
//
// Объём строго сохраняется:
// 1. Любая воронка или подошва вытесняет песок в валик.
// 2. Двумерный векторный перенос ветра и осыпь перемещают массу с сохранением баланса.
// 3. Перенос через швы передается в соседние чанки без потерь.
// 4. При LRU-вытеснении недеформированные данные не теряются: деформации сохраняются
//    в постоянном хранилище чанков и восстанавливаются при повторной загрузке.
import { CHUNK, SANDFIELD, SAND, HEXAPOD } from '../config.ts';
import { getDuneHeight } from '../core/duneField.ts';
import { chunkCoordAt, chunkKeyOf } from '../core/chunkCoords.ts';
import {
    getInterpolatedSandProperties,
    computeUltimateBearingCapacity,
    bekkerSinkage,
    janosiShearStress,
    janosiFrictionCoefficient,
    computeBulldozingResistance,
    classifySoilMaterial,
    SOIL_MATERIALS
} from './terramechanics.ts';

const SEG = CHUNK.gridSegments;
const N = SEG + 1;
const CELL = CHUNK.size / SEG;
const HALF = CHUNK.size * 0.5;
const CELLS = N * N;

// Профиль радиального отпечатка: дно воронки до 0.72 радиуса, валик — до 1.18.
const CRATER_EDGE = 0.72;
const RIM_END = 1.18;
const HALF_PI = Math.PI * 0.5;

// Сколько чанков с изменённым песком помним в оперативной памяти.
const MAX_CACHED_CHUNKS = 220;

// Черновики обхода воронки/подошвы
const scratchIndex = new Int32Array(1024);
const scratchWeight = new Float64Array(1024);
const scratchAmount = new Float64Array(1024);
const scratchDeposit = new Float64Array(1024);
const scratchBefore = new Float64Array(1024);

// Черновики потока общие на все чанки
const stateMass = new Float32Array(CELLS);
const statePack = new Float32Array(CELLS);
const flowMass = new Float32Array(CELLS);
const flowPack = new Float32Array(CELLS);

// Смещения 8 соседей для безмусорного обхода в withdrawMass / depositMass
const NB_DC = [1, -1, 0, 0, 1, -1, 1, -1];
const NB_DR = [0, 0, 1, -1, 1, -1, -1, 1];

export interface ChunkRecordInternal {
    key: string;
    cx: number;
    cz: number;
    originX: number;
    originZ: number;
    delta: Float32Array;
    packing: Float32Array;
    slipX: Float32Array | null;
    slipZ: Float32Array | null;
    pendingDelta: Float32Array | null;
    pendingPack: Float32Array | null;
    attached: boolean;
    touched: boolean;
    heightRevision: number;
    materialRevision: number;
    used: number;
    dirtyMinCol: number;
    dirtyMaxCol: number;
    dirtyMinRow: number;
    dirtyMaxRow: number;
    hasDirtyRegion: boolean;
}

export interface EvictedChunkData {
    delta: Float32Array;
    packing: Float32Array;
}

export interface DirtyBounds {
    minCol: number;
    maxCol: number;
    minRow: number;
    maxRow: number;
}

export interface SandFieldStats {
    chunks: number;
    attached: number;
    dirty: number;
    materialDirty: number;
    contactDirty: number;
    physicsDirty: number;
    deformed: number;
    packed: number;
    evictedChunks: number;
    worldReserve: number;
    stepDurationMs: number;
    syncLatencyMs: number;
    lastSyncDurationMs: number;
}

export interface SoleFootprintOptions {
    width?: number;
    length?: number;
    heading?: number;
    yaw?: number;
    pitch?: number;
    roll?: number;
    depth?: number;
    sinkDepth?: number;
    packingGain?: number;
    useSoleShape?: boolean;
}

export interface SandContactResult {
    supportY: number;
    sink: number;
    packing: number;
    pressure: number;
    traction: number;
    displaced: number;
    sinkStep: number;
    sinkRate: number;
    material: string;
    bearingCapacity: number;
    effectiveFriction: number;
    bulldozeForce: number;
}

function createChunkRecord(cx: number, cz: number, savedState: Partial<EvictedChunkData> | null = null): ChunkRecordInternal {
    const originX = cx * CHUNK.size;
    const originZ = cz * CHUNK.size;
    const delta = savedState?.delta ? new Float32Array(savedState.delta) : new Float32Array(CELLS);
    const packing = savedState?.packing ? new Float32Array(savedState.packing) : new Float32Array(CELLS);
    const hasData = !!savedState;

    return {
        key: chunkKeyOf(cx, cz),
        cx,
        cz,
        originX,
        originZ,
        delta,
        packing,
        slipX: new Float32Array(CELLS),
        slipZ: new Float32Array(CELLS),
        pendingDelta: null,
        pendingPack: null,
        attached: false,
        touched: hasData,
        heightRevision: 0,
        materialRevision: 0,
        used: 0,
        // Ограничивающий прямоугольник изменённых ячеек для частичного обновления меша
        dirtyMinCol: SEG,
        dirtyMaxCol: 0,
        dirtyMinRow: SEG,
        dirtyMaxRow: 0,
        hasDirtyRegion: false
    };
}

export function createSandField() {
    const chunks = new Map<string, ChunkRecordInternal>();       // key -> запись чанка
    const pinned: string[] = [];              // ключи загруженных чанков
    const heightDirty = new Set<ChunkRecordInternal>();
    const materialDirty = new Set<ChunkRecordInternal>();
    const contactDirty = new Set<ChunkRecordInternal>();
    const physicsDirty = new Set<ChunkRecordInternal>(); // Чанки, ожидающие своевременной синхронизации Rapier

    // Постоянное хранилище деформаций вытесненных чанков для строгого сохранения массы
    const evictedStore = new Map<string, EvictedChunkData>();

    // Мировой резерв массы песка (выброс за границы чанков, взвешенная бурей пыль)
    let worldReserve = 0.0;
    let lastStepDurationMs = 0.0;
    let lastSyncDurationMs = 0.0;
    let lastDirtyTimestamp = 0.0;
    let syncLatencyMs = 0.0;

    let cachedCount = 0;
    let useClock = 0;
    let windAccum = 0;
    let transportCursor = 0;
    let reposeAccum = 0;
    let reposeCursor = 0;

    function expandDirtyBox(rec: ChunkRecordInternal, c0: number, c1: number, r0: number, r1: number): void {
        const minC = Math.max(0, Math.min(c0, c1));
        const maxC = Math.min(SEG, Math.max(c0, c1));
        const minR = Math.max(0, Math.min(r0, r1));
        const maxR = Math.min(SEG, Math.max(r0, r1));

        if (!rec.hasDirtyRegion) {
            rec.dirtyMinCol = minC;
            rec.dirtyMaxCol = maxC;
            rec.dirtyMinRow = minR;
            rec.dirtyMaxRow = maxR;
            rec.hasDirtyRegion = true;
        } else {
            rec.dirtyMinCol = Math.min(rec.dirtyMinCol, minC);
            rec.dirtyMaxCol = Math.max(rec.dirtyMaxCol, maxC);
            rec.dirtyMinRow = Math.min(rec.dirtyMinRow, minR);
            rec.dirtyMaxRow = Math.max(rec.dirtyMaxRow, maxR);
        }
    }

    // --- Доступ к записям -------------------------------------------------

    function recordFor(cx: number, cz: number): ChunkRecordInternal {
        const key = chunkKeyOf(cx, cz);
        let rec = chunks.get(key);
        if (!rec) {
            const saved = evictedStore.get(key);
            rec = createChunkRecord(cx, cz, saved);
            if (saved) evictedStore.delete(key);
            rec.used = ++useClock;
            chunks.set(key, rec);
            if (!rec.attached) cachedCount++;
            evictCache();
        }
        rec.used = ++useClock;
        return rec;
    }

    function recordAt(x: number, z: number): ChunkRecordInternal | undefined {
        return chunks.get(chunkKeyOf(chunkCoordAt(x), chunkCoordAt(z)));
    }

    // При вытеснении из кэша память освобождается, но изменённые ячейки
    // сохраняются в evictedStore, поэтому объём и следы никогда не исчезают.
    function evictCache(): void {
        while (cachedCount > MAX_CACHED_CHUNKS) {
            let oldest: ChunkRecordInternal | null = null;
            for (const rec of chunks.values()) {
                if (rec.attached) continue;
                if (!oldest || rec.used < oldest.used) oldest = rec;
            }
            if (!oldest) return;

            clearDirty(oldest);
            if (oldest.pendingDelta) absorbSeam(oldest);

            if (oldest.touched) {
                // Сохраняем состояние изменённого чанка
                evictedStore.set(oldest.key, {
                    delta: new Float32Array(oldest.delta),
                    packing: new Float32Array(oldest.packing)
                });
            }
            chunks.delete(oldest.key);
            cachedCount--;
        }
    }

    function attachChunk(cx: number, cz: number): ChunkRecordInternal {
        const rec = chunks.get(chunkKeyOf(cx, cz)) || recordFor(cx, cz);
        if (!rec.attached) {
            rec.attached = true;
            if (cachedCount > 0) cachedCount--;
            pinned.push(rec.key);
        }
        if (!rec.slipX) {
            rec.slipX = new Float32Array(CELLS);
            rec.slipZ = new Float32Array(CELLS);
        }
        rec.used = ++useClock;
        return rec;
    }

    function detachChunk(cx: number, cz: number): void {
        const key = chunkKeyOf(cx, cz);
        const rec = chunks.get(key);
        if (!rec || !rec.attached) return;

        clearDirty(rec);
        // Впитываем любые остаточные швы перед отсоединением, чтобы масса не пропала
        if (rec.pendingDelta) absorbSeam(rec);

        rec.attached = false;
        cachedCount++;
        if (rec.slipX?.some((value: number) => value !== 0) || rec.slipZ?.some((value: number) => value !== 0)) {
            rec.materialRevision++;
        }
        rec.slipX = null;
        rec.slipZ = null;
        rec.pendingDelta = null;
        rec.pendingPack = null;

        const index = pinned.indexOf(key);
        if (index !== -1) pinned.splice(index, 1);

        if (!rec.touched) {
            chunks.delete(key);
            cachedCount--;
        }
        evictCache();
    }

    // --- Выборка поля -----------------------------------------------------

    function bilinear(array: Float32Array, colF: number, rowF: number): number {
        let c0 = Math.floor(colF);
        let r0 = Math.floor(rowF);
        if (c0 < 0) c0 = 0; else if (c0 > SEG - 1) c0 = SEG - 1;
        if (r0 < 0) r0 = 0; else if (r0 > SEG - 1) r0 = SEG - 1;
        const fx = Math.min(1, Math.max(0, colF - c0));
        const fz = Math.min(1, Math.max(0, rowF - r0));
        const c1 = c0 + 1;
        const r1 = r0 + 1;
        const h00 = array[r0 * N + c0];
        const h10 = array[r0 * N + c1];
        const h01 = array[r1 * N + c0];
        const h11 = array[r1 * N + c1];
        return (h00 + (h10 - h00) * fx) * (1 - fz) + (h01 + (h11 - h01) * fx) * fz;
    }

    function sampleChannel(rec: ChunkRecordInternal, array: Float32Array | null, x: number, z: number): number {
        if (!array) return 0;
        const colF = (x - rec.originX + HALF) / CELL;
        const rowF = (z - rec.originZ + HALF) / CELL;
        return bilinear(array, colF, rowF);
    }

    function sampleDelta(x: number, z: number): number {
        const rec = recordAt(x, z);
        if (!rec) return 0;
        return sampleChannel(rec, rec.delta, x, z);
    }

    function samplePacking(x: number, z: number): number {
        const rec = recordAt(x, z);
        if (!rec) return 0;
        return sampleChannel(rec, rec.packing, x, z);
    }

    function sampleHeight(x: number, z: number): number {
        return getDuneHeight(x, z) + sampleDelta(x, z);
    }

    function sampleNormal<T extends { set(x: number, y: number, z: number): any; normalize(): any }>(
        x: number,
        z: number,
        baseNormal: { x: number; y: number; z: number } | null,
        out: T
    ): T {
        const e = CELL;
        const dx = (sampleDelta(x + e, z) - sampleDelta(x - e, z)) / (2 * e);
        const dz = (sampleDelta(x, z + e) - sampleDelta(x, z - e)) / (2 * e);
        const ny = Math.max(0.2, baseNormal ? baseNormal.y : 1);
        const bx = baseNormal ? -baseNormal.x / ny : 0;
        const bz = baseNormal ? -baseNormal.z / ny : 0;
        out.set(-(bx + dx), 1, -(bz + dz)).normalize();
        return out;
    }

    // --- Очереди обновлений -----------------------------------------------

    function clearDirty(rec: ChunkRecordInternal): void {
        heightDirty.delete(rec);
        materialDirty.delete(rec);
        contactDirty.delete(rec);
        physicsDirty.delete(rec);
    }

    function markHeight(rec: ChunkRecordInternal, urgent: boolean = false): void {
        rec.heightRevision++;
        rec.touched = true;
        if (!rec.attached) return;
        if (physicsDirty.size === 0) {
            lastDirtyTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
        }
        heightDirty.add(rec);
        physicsDirty.add(rec);
        if (urgent) contactDirty.add(rec);
    }

    function markMaterial(rec: ChunkRecordInternal): void {
        rec.materialRevision++;
        rec.touched = true;
        if (rec.attached) materialDirty.add(rec);
    }

    function consumeQueue(queue: Set<ChunkRecordInternal>, limit: number): string[] {
        const out: string[] = [];
        for (const rec of queue) {
            if (out.length >= limit) break;
            queue.delete(rec);
            if (rec.attached && chunks.get(rec.key) === rec) out.push(rec.key);
        }
        return out;
    }

    function consumeDirty(limit: number = 4): string[] {
        return consumeQueue(heightDirty, limit);
    }

    function consumeVisualDirty(limit: number = 4): string[] {
        const out = consumeDirty(limit);
        for (const key of out) {
            const r = chunks.get(key);
            if (r) materialDirty.delete(r);
        }
        out.push(...consumeQueue(materialDirty, Math.max(0, limit - out.length)));
        return out;
    }

    function consumeContactDirty(): string[] {
        return consumeQueue(contactDirty, Infinity);
    }

    function consumePhysicsDirty(limit: number = Infinity): string[] {
        if (lastDirtyTimestamp > 0) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            syncLatencyMs = now - lastDirtyTimestamp;
            lastDirtyTimestamp = 0;
        }
        return consumeQueue(physicsDirty, limit);
    }

    // --- Деформация: воронка и распределённая подошва ----------------------

    function craterInChunk(
        rec: ChunkRecordInternal,
        x: number,
        z: number,
        radius: number,
        depth: number,
        packingGain: number
    ): number {
        const colC = (x - rec.originX + HALF) / CELL;
        const rowC = (z - rec.originZ + HALF) / CELL;
        const cellR = radius / CELL;
        const c0 = Math.max(1, Math.floor(colC - cellR));
        const c1 = Math.min(SEG - 1, Math.ceil(colC + cellR));
        const r0 = Math.max(1, Math.floor(rowC - cellR));
        const r1 = Math.min(SEG - 1, Math.ceil(rowC + cellR));
        if (c0 > c1 || r0 > r1) return 0;

        const delta = rec.delta;
        let removed = 0;
        let rimWeight = 0;
        let count = 0;

        for (let row = r0; row <= r1; row++) {
            const wz = rec.originZ - HALF + row * CELL;
            for (let col = c0; col <= c1; col++) {
                const wx = rec.originX - HALF + col * CELL;
                const dx = wx - x;
                const dz = wz - z;
                const dist = Math.sqrt(dx * dx + dz * dz) / radius;
                if (dist >= RIM_END) continue;

                const index = row * N + col;
                if (dist < CRATER_EDGE) {
                    const w = Math.cos((dist / CRATER_EDGE) * HALF_PI);
                    if (w <= 0.001) continue;
                    const room = SANDFIELD.maxDelta + delta[index];
                    const amount = Math.min(depth * w, Math.max(0, room));
                    if (amount <= 1e-6) continue;
                    scratchIndex[count] = index;
                    scratchAmount[count] = amount;
                    scratchWeight[count] = 0;
                    count++;
                    removed += amount;
                } else {
                    const t = (dist - CRATER_EDGE) / (RIM_END - CRATER_EDGE);
                    const w = Math.sin(t * Math.PI);
                    if (w <= 0.001) continue;
                    scratchIndex[count] = index;
                    scratchAmount[count] = 0;
                    scratchWeight[count] = w;
                    count++;
                    rimWeight += w;
                }
                if (count >= scratchIndex.length) break;
            }
            if (count >= scratchIndex.length) break;
        }

        if (removed <= 1e-6 || rimWeight <= 1e-6) return 0;

        const rimGain = removed / rimWeight;
        let placed = 0.0;
        for (let i = 0; i < count; i++) {
            const before = delta[scratchIndex[i]];
            scratchBefore[i] = before;
            const requested = scratchWeight[i] * rimGain;
            const room = Math.max(0.0, SANDFIELD.maxDelta - before);
            const deposition = Math.min(requested, room);
            scratchDeposit[i] = Math.max(0, Math.fround(before + deposition) - before);
            placed += scratchDeposit[i];
        }

        if (placed <= 0) return 0;
        const keep = Math.min(1, placed / removed);
        let balance = 0;
        for (let i = 0; i < count; i++) {
            const index = scratchIndex[i];
            delta[index] = scratchWeight[i] > 0
                ? scratchBefore[i] + scratchDeposit[i]
                : scratchBefore[i] - scratchAmount[i] * keep;
            balance += delta[index] - scratchBefore[i];
        }

        for (let i = 0; i < count && balance !== 0; i++) {
            const index = scratchIndex[i];
            const current = delta[index];
            const before = scratchBefore[i];
            if ((balance > 0 && current <= before) || (balance < 0 && current >= before)) continue;
            const next = Math.fround(Math.max(Math.min(before, current),
                Math.min(Math.max(before, current), current - balance)));
            const nextBalance = balance + next - current;
            if (Math.abs(nextBalance) < Math.abs(balance)) {
                delta[index] = next;
                balance = nextBalance;
            }
        }

        let actualRemoved = 0;
        let changed = false;
        let materialChanged = false;
        for (let i = 0; i < count; i++) {
            const index = scratchIndex[i];
            const cut = Math.max(0, scratchBefore[i] - delta[index]);
            actualRemoved += cut;
            changed ||= delta[index] !== scratchBefore[i];
            if (cut > 0 && packingGain > 0) {
                const beforePacking = rec.packing[index];
                rec.packing[index] = Math.min(1, beforePacking + packingGain * cut / scratchAmount[i]);
                materialChanged ||= rec.packing[index] !== beforePacking;
            }
        }
        if (changed) {
            expandDirtyBox(rec, c0, c1, r0, r1);
            markHeight(rec, true);
        }
        if (materialChanged) markMaterial(rec);
        return actualRemoved * CELL * CELL;
    }

    function stampCrater(
        x: number,
        z: number,
        radius: number,
        depth: number,
        packingGain: number = 0
    ): number {
        if (depth <= 0 || radius <= 0) return 0;
        let displaced = 0;
        const minCx = chunkCoordAt(x - radius);
        const maxCx = chunkCoordAt(x + radius);
        const minCz = chunkCoordAt(z - radius);
        const maxCz = chunkCoordAt(z + radius);

        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cx = minCx; cx <= maxCx; cx++) {
                const rec = recordFor(cx, cz);
                displaced += craterInChunk(rec, x, z, radius, depth, packingGain);
            }
        }
        return displaced;
    }

    // Распределённый отпечаток подошвы стопы с ориентацией по курсу, наклону и крену через границы чанков
    function stampSole(
        x: number,
        z: number,
        width: number,
        length: number,
        heading: number = 0,
        pitch: number = 0,
        roll: number = 0,
        depth: number = 0.035,
        packingGain: number = 0
    ): number {
        if (depth <= 0 || width <= 0 || length <= 0) return 0;
        const effHalfW = Math.max(width * 0.5, CELL * 0.55);
        const effHalfL = Math.max(length * 0.5, CELL * 0.75);
        const dRim = Math.max(0.65, CELL * 1.5);
        const radius = Math.hypot(effHalfW, effHalfL) + dRim;
        const minCx = chunkCoordAt(x - radius);
        const maxCx = chunkCoordAt(x + radius);
        const minCz = chunkCoordAt(z - radius);
        const maxCz = chunkCoordAt(z + radius);

        let displaced = 0;
        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cx = minCx; cx <= maxCx; cx++) {
                const rec = recordFor(cx, cz);
                displaced += soleFootprintInChunk(
                    rec, x, z, width, length,
                    heading, pitch, roll,
                    depth, packingGain
                );
            }
        }
        return displaced;
    }

    // Распределённый отпечаток подошвы с учётом реальной площади, наклона и моментов
    function soleFootprintInChunk(
        recOrKey: ChunkRecordInternal | string,
        x: number,
        z: number,
        soleW: number | SoleFootprintOptions,
        soleL: number = 0,
        heading: number = 0,
        pitch: number = 0,
        roll: number = 0,
        depth: number = 0.035,
        packingGain: number = 0
    ): number {
        const rec = typeof recOrKey === 'string'
            ? (chunks.get(recOrKey) || recordFor(chunkCoordAt(x), chunkCoordAt(z)))
            : recOrKey;
        if (!rec) return 0;

        let sW = typeof soleW === 'number' ? soleW : 0;
        let sL = soleL, hd = heading, pt = pitch, rl = roll, dp = depth, pk = packingGain;
        if (soleW && typeof soleW === 'object') {
            sW = soleW.width || 0;
            sL = soleW.length || 0;
            hd = soleW.yaw ?? soleW.heading ?? 0;
            pt = soleW.pitch || 0;
            rl = soleW.roll || 0;
            dp = soleW.sinkDepth ?? soleW.depth ?? 0.035;
            pk = soleW.packingGain || 0;
        }

        const halfW = (sW || HEXAPOD.footWidth || 0.82) * 0.5;
        const halfL = (sL || HEXAPOD.footLength || 0.82) * 0.5;
        const effHalfW = Math.max(halfW, CELL * 0.55);
        const effHalfL = Math.max(halfL, CELL * 0.75);
        const dRim = Math.max(0.65, CELL * 1.5);
        const rBound = Math.hypot(effHalfW, effHalfL) + dRim;

        const colC = (x - rec.originX + HALF) / CELL;
        const rowC = (z - rec.originZ + HALF) / CELL;
        const cellR = rBound / CELL;
        const c0 = Math.max(1, Math.floor(colC - cellR));
        const c1 = Math.min(SEG - 1, Math.ceil(colC + cellR));
        const r0 = Math.max(1, Math.floor(rowC - cellR));
        const r1 = Math.min(SEG - 1, Math.ceil(rowC + cellR));
        if (c0 > c1 || r0 > r1) return 0;

        const cosYaw = Math.cos(hd || 0);
        const sinYaw = Math.sin(hd || 0);
        const delta = rec.delta;
        let removed = 0;
        let rimWeight = 0;
        let count = 0;

        for (let row = r0; row <= r1; row++) {
            const wz = rec.originZ - HALF + row * CELL;
            for (let col = c0; col <= c1; col++) {
                const wx = rec.originX - HALF + col * CELL;
                const gx = wx - x;
                const gz = wz - z;

                // Перевод в локальную систему координат подошвы (u: носок-пятка, v: влево-вправо)
                const u = gx * sinYaw + gz * cosYaw;
                const v = gx * cosYaw - gz * sinYaw;

                const du = Math.max(0, Math.abs(u) - effHalfL);
                const dv = Math.max(0, Math.abs(v) - effHalfW);
                const dOut = Math.max(du, dv);

                if (dOut > dRim) continue;

                const index = row * N + col;
                if (du === 0 && dv === 0) {
                    // Внутри подошвы: давление модулируется наклоном носок-пятка и креном
                    const pitchGrad = Math.sin(pt || 0) * 1.8;
                    const rollGrad = Math.sin(rl || 0) * 1.8;
                    const normU = effHalfL > 0 ? u / effHalfL : 0;
                    const normV = effHalfW > 0 ? v / effHalfW : 0;
                    const pressureMod = Math.max(0.15, 1.0 + pitchGrad * normU + rollGrad * normV);
                    const boxDist = Math.max(Math.abs(normU), Math.abs(normV));
                    const w = Math.cos(boxDist * HALF_PI) * pressureMod;

                    const room = SANDFIELD.maxDelta + delta[index];
                    const amount = Math.min(dp * w, Math.max(0, room));
                    if (amount <= 1e-6) continue;
                    scratchIndex[count] = index;
                    scratchAmount[count] = amount;
                    scratchWeight[count] = 0;
                    count++;
                    removed += amount;
                } else {
                    // Валик вокруг подошвы с асимметрией по уклону
                    const t = dOut / dRim;
                    const pitchGrad = Math.sin(pt || 0) * 1.2;
                    const rollGrad = Math.sin(rl || 0) * 1.2;
                    const normU = effHalfL > 0 ? u / (effHalfL + dRim) : 0;
                    const normV = effHalfW > 0 ? v / (effHalfW + dRim) : 0;
                    const rimMod = Math.max(0.15, 1.0 + pitchGrad * normU + rollGrad * normV);
                    const w = Math.sin((1.0 - t) * Math.PI) * rimMod;
                    if (w <= 0.001) continue;
                    scratchIndex[count] = index;
                    scratchAmount[count] = 0;
                    scratchWeight[count] = w;
                    count++;
                    rimWeight += w;
                }
                if (count >= scratchIndex.length) break;
            }
            if (count >= scratchIndex.length) break;
        }

        if (removed <= 1e-6 || rimWeight <= 1e-6) return 0;

        const rimGain = removed / rimWeight;
        let placed = 0.0;
        for (let i = 0; i < count; i++) {
            const before = delta[scratchIndex[i]];
            scratchBefore[i] = before;
            const requested = scratchWeight[i] * rimGain;
            const room = Math.max(0.0, SANDFIELD.maxDelta - before);
            const deposition = Math.min(requested, room);
            scratchDeposit[i] = Math.max(0, Math.fround(before + deposition) - before);
            placed += scratchDeposit[i];
        }

        if (placed <= 0) return 0;
        const keep = Math.min(1, placed / removed);
        let balance = 0;
        for (let i = 0; i < count; i++) {
            const index = scratchIndex[i];
            delta[index] = scratchWeight[i] > 0
                ? scratchBefore[i] + scratchDeposit[i]
                : scratchBefore[i] - scratchAmount[i] * keep;
            balance += delta[index] - scratchBefore[i];
        }

        for (let i = 0; i < count && balance !== 0; i++) {
            const index = scratchIndex[i];
            const current = delta[index];
            const before = scratchBefore[i];
            if ((balance > 0 && current <= before) || (balance < 0 && current >= before)) continue;
            const next = Math.fround(Math.max(Math.min(before, current),
                Math.min(Math.max(before, current), current - balance)));
            const nextBalance = balance + next - current;
            if (Math.abs(nextBalance) < Math.abs(balance)) {
                delta[index] = next;
                balance = nextBalance;
            }
        }

        let actualRemoved = 0;
        let changed = false;
        let materialChanged = false;
        for (let i = 0; i < count; i++) {
            const index = scratchIndex[i];
            const cut = Math.max(0, scratchBefore[i] - delta[index]);
            actualRemoved += cut;
            changed ||= delta[index] !== scratchBefore[i];
            if (cut > 0 && packingGain > 0) {
                const beforePacking = rec.packing[index];
                rec.packing[index] = Math.min(1, beforePacking + packingGain * cut / scratchAmount[i]);
                materialChanged ||= rec.packing[index] !== beforePacking;
            }
        }
        if (changed) {
            expandDirtyBox(rec, c0, c1, r0, r1);
            markHeight(rec, true);
        }
        if (materialChanged) markMaterial(rec);
        return actualRemoved * CELL * CELL;
    }

    // --- Контакт лапы по террамеханике (Беккер + Яноси-Ханамото) ------------

    function writeSlip(x: number, z: number, sx: number, sz: number): void {
        const rec = recordAt(x, z);
        if (!rec || !rec.slipX || !rec.slipZ) return;

        const col = Math.round((x - rec.originX + HALF) / CELL);
        const row = Math.round((z - rec.originZ + HALF) / CELL);
        const c = col < 0 ? 0 : (col > SEG ? SEG : col);
        const r = row < 0 ? 0 : (row > SEG ? SEG : row);
        const index = r * N + c;
        const nextX = Math.fround(sx);
        const nextZ = Math.fround(sz);
        if (rec.slipX[index] === nextX && rec.slipZ[index] === nextZ) return;
        rec.slipX[index] = nextX;
        rec.slipZ[index] = nextZ;
        markMaterial(rec);
    }

    function contact(
        x: number,
        z: number,
        radius: number,
        load: number,
        area: number,
        dt: number,
        anchorShift: { x: number; y: number; z: number } | null = null,
        canScourAt: ((x: number, z: number) => boolean) | null = null,
        soleOptions: (SoleFootprintOptions & { terramechanics?: boolean; anchorScour?: boolean }) | null = null
    ): SandContactResult {
        const beforeDelta = sampleDelta(x, z);
        const beforePacking = samplePacking(x, z);
        const normalLoad = Number.isFinite(load) && load > SANDFIELD.loadEpsilon ? load : 0;
        const validArea = Number.isFinite(area) && area > 0;
        const pressure = validArea ? normalLoad / area : 0;

        if (normalLoad === 0 || !Number.isFinite(dt) || dt <= 0
            || !validArea || !Number.isFinite(radius) || radius <= 0) {
            const grip = SANDFIELD.gripLoose
                + (SANDFIELD.gripPacked - SANDFIELD.gripLoose) * beforePacking;
            return {
                supportY: getDuneHeight(x, z) + beforeDelta,
                sink: Math.max(0, -beforeDelta),
                packing: beforePacking,
                pressure,
                traction: grip * normalLoad,
                displaced: 0,
                sinkStep: 0,
                sinkRate: 0,
                material: 'loose_sand',
                bearingCapacity: SANDFIELD.bearingMin,
                effectiveFriction: grip,
                bulldozeForce: 0
            };
        }

        const useTerra = soleOptions?.terramechanics === true;
        const mat = getInterpolatedSandProperties(beforePacking);
        const footW = soleOptions?.width || HEXAPOD.footWidth || (radius * 1.5);
        const footL = soleOptions?.length || HEXAPOD.footLength || (radius * 1.5);
        const currentSink = Math.max(0, -beforeDelta);

        let requestedStep = 0;
        let speed = 0;
        let compactTarget = 0;
        let compactGain = 0;
        const room = Math.max(0, SANDFIELD.maxSinkDepth + beforeDelta);

        if (useTerra) {
            const qUlt = computeUltimateBearingCapacity(mat, footW, currentSink);
            const bekkerZ = bekkerSinkage(pressure, footW, mat);
            const excess = Math.max(0, pressure - qUlt);
            const sinkRateTarget = excess > 0
                ? Math.min(mat.maxSinkRate, excess / SANDFIELD.penetration + (bekkerZ - currentSink) * 0.5)
                : Math.max(0, (bekkerZ - currentSink) * 0.2);
            speed = Math.min(mat.maxSinkRate, sinkRateTarget);
            requestedStep = Math.min(speed * dt, room);
            const bearingFull = mat.bearingCapacityBase * 1.5;
            compactTarget = Math.min(1, pressure / bearingFull);
            compactGain = Math.min(SANDFIELD.compactionMaxGain, SANDFIELD.compactionRate * dt * (1 + beforePacking * 0.3));
        } else {
            const capacity = SANDFIELD.bearingMin + beforePacking * SANDFIELD.bearingRange;
            const excess = Math.max(0, pressure - capacity);
            speed = Math.min(SANDFIELD.maxSinkRate, excess / SANDFIELD.penetration);
            requestedStep = Math.min(speed * dt, room);
            const bearingFull = SANDFIELD.bearingMin + SANDFIELD.bearingRange;
            compactTarget = Math.min(1, pressure / bearingFull);
            compactGain = Math.min(SANDFIELD.compactionMaxGain, SANDFIELD.compactionRate * dt);
        }

        let displaced = 0;
        if (requestedStep > 0) {
            if (soleOptions?.useSoleShape) {
                const minCx = chunkCoordAt(x - radius);
                const maxCx = chunkCoordAt(x + radius);
                const minCz = chunkCoordAt(z - radius);
                const maxCz = chunkCoordAt(z + radius);
                for (let cz = minCz; cz <= maxCz; cz++) {
                    for (let cx = minCx; cx <= maxCx; cx++) {
                        const rec = recordFor(cx, cz);
                        displaced += soleFootprintInChunk(
                            rec, x, z, footW, footL,
                            soleOptions.heading, soleOptions.pitch, soleOptions.roll,
                            requestedStep, 0
                        );
                    }
                }
            } else {
                displaced = stampCrater(x, z, radius, requestedStep, 0);
            }
        }
        compressPatch(x, z, radius, compactTarget, compactGain);

        const validShift = anchorShift && Number.isFinite(anchorShift.x)
            && Number.isFinite(anchorShift.y) && Number.isFinite(anchorShift.z);
        const dx = validShift ? anchorShift.x : 0;
        const dy = validShift ? anchorShift.y : 0;
        const dz = validShift ? anchorShift.z : 0;
        const slip = Math.hypot(dx, dy, dz) / dt;

        if (slip > SANDFIELD.slipScourThreshold && Math.hypot(dx, dz) > 1e-5) {
            const depth = Math.min(
                SAND.stepFootprintDepth * 0.35,
                (slip - SANDFIELD.slipScourThreshold) * SANDFIELD.slipScourGain * dt
            );
            const scourX = x - dx * 0.5;
            const scourZ = z - dz * 0.5;
            if (depth > 1e-5 && (!canScourAt || (canScourAt(x, z)
                && canScourAt(scourX, scourZ) && canScourAt(x - dx, z - dz)))) {
                displaced += stampCrater(scourX, scourZ, radius * 0.8, depth, 0);
            }
        }
        writeSlip(x, z, dx / dt, dz / dt);

        const packing = samplePacking(x, z);
        let traction = 0;
        let muEff = 0;
        if (useTerra) {
            const shearDisp = Math.hypot(dx, dz);
            muEff = janosiFrictionCoefficient(shearDisp, pressure, mat);
            traction = muEff * normalLoad;
        } else {
            muEff = SANDFIELD.gripLoose + (SANDFIELD.gripPacked - SANDFIELD.gripLoose) * packing;
            traction = muEff * normalLoad;
        }

        const delta = sampleDelta(x, z);
        const sinkStep = Math.max(0, beforeDelta - delta);

        return {
            supportY: getDuneHeight(x, z) + delta,
            sink: Math.max(0.0, -delta),
            packing,
            pressure,
            traction,
            displaced,
            sinkStep,
            sinkRate: sinkStep / dt,
            material: mat.id,
            bearingCapacity: SANDFIELD.bearingMin + packing * SANDFIELD.bearingRange,
            effectiveFriction: muEff,
            bulldozeForce: computeBulldozingResistance(sinkStep, footW, mat)
        };
    }

    function compressPatch(x: number, z: number, radius: number, target: number, gain: number): void {
        const rec = recordAt(x, z) || recordFor(chunkCoordAt(x), chunkCoordAt(z));
        const colC = (x - rec.originX + HALF) / CELL;
        const rowC = (z - rec.originZ + HALF) / CELL;
        const cellR = radius / CELL;
        const c0 = Math.max(0, Math.floor(colC - cellR));
        const c1 = Math.min(SEG, Math.ceil(colC + cellR));
        const r0 = Math.max(0, Math.floor(rowC - cellR));
        const r1 = Math.min(SEG, Math.ceil(rowC + cellR));
        let changed = false;

        for (let row = r0; row <= r1; row++) {
            const wz = rec.originZ - HALF + row * CELL;
            for (let col = c0; col <= c1; col++) {
                const wx = rec.originX - HALF + col * CELL;
                const dist = Math.hypot(wx - x, wz - z) / radius;
                if (dist >= 1) continue;
                const w = Math.cos(dist * HALF_PI);
                const index = row * N + col;
                const packing = rec.packing[index];
                const next = Math.fround(Math.min(1, packing + Math.max(0, target - packing) * gain * w));
                if (next !== rec.packing[index]) {
                    rec.packing[index] = next;
                    changed = true;
                }
            }
        }
        if (changed) markMaterial(rec);
    }

    function land(
        x: number,
        z: number,
        radius: number,
        impactSpeed: number,
        load: number = 0,
        soleOptions: SoleFootprintOptions | null = null
    ): number {
        const packing = samplePacking(x, z);
        const base = 0.06 + Math.max(0, impactSpeed) * SANDFIELD.landImpact;
        const depth = Math.min(SAND.stepFootprintDepth, base) * (1.0 - 0.65 * packing);
        const compaction = load > 0 ? Math.min(0.25, load / 4000) : 0.08;
        if (soleOptions?.useSoleShape) {
            const footW = soleOptions.width || HEXAPOD.footWidth || (radius * 1.5);
            const footL = soleOptions.length || HEXAPOD.footLength || (radius * 1.5);
            const minCx = chunkCoordAt(x - radius);
            const maxCx = chunkCoordAt(x + radius);
            const minCz = chunkCoordAt(z - radius);
            const maxCz = chunkCoordAt(z + radius);
            let displaced = 0;
            for (let cz = minCz; cz <= maxCz; cz++) {
                for (let cx = minCx; cx <= maxCx; cx++) {
                    const rec = recordFor(cx, cz);
                    displaced += soleFootprintInChunk(
                        rec, x, z, footW, footL,
                        soleOptions.heading || 0, soleOptions.pitch || 0, soleOptions.roll || 0,
                        depth, compaction
                    );
                }
            }
            return displaced;
        }
        return stampCrater(x, z, radius, depth, compaction);
    }

    // --- Перенос песка через шов и двумерный поток -------------------------

    function addSeamInflow(cx: number, cz: number, index: number, mass: number, packMass: number): void {
        const rec = chunks.get(chunkKeyOf(cx, cz)) || recordFor(cx, cz);
        if (!rec) return;

        if (!rec.pendingDelta || !rec.pendingPack) {
            rec.pendingDelta = new Float32Array(CELLS);
            rec.pendingPack = new Float32Array(CELLS);
        }
        rec.pendingDelta[index] += mass;
        rec.pendingPack[index] += packMass;
    }

    function pushSeam(rec: ChunkRecordInternal, tCol: number, tRow: number, mass: number, pack: number): number {
        let cx = rec.cx;
        let cz = rec.cz;
        let col = tCol;
        let row = tRow;

        if (col < 0) {
            cx--;
            col = SEG - 1;
        } else if (col > SEG) {
            cx++;
            col = 1;
        }
        if (row < 0) {
            cz--;
            row = SEG - 1;
        } else if (row > SEG) {
            cz++;
            row = 1;
        }

        const target = chunks.get(chunkKeyOf(cx, cz)) || recordFor(cx, cz);
        if (!target) return 0.0;

        const index = row * N + col;
        const room = Math.max(0.0, SANDFIELD.maxDelta - target.delta[index]);
        const moved = Math.min(mass, room);
        if (moved <= 1e-6) return 0.0;

        addSeamInflow(cx, cz, index, moved, moved * pack);
        return moved;
    }

    function absorbSeam(rec: ChunkRecordInternal): void {
        const pendingDelta = rec.pendingDelta;
        if (!pendingDelta) return;

        const pendingPack = rec.pendingPack;
        if (!pendingPack) return;
        const delta = rec.delta;
        const packing = rec.packing;
        let heightChanged = false;
        let materialChanged = false;

        for (let i = 0; i < CELLS; i++) {
            const mass = pendingDelta[i];
            if (mass === 0.0) continue;

            const packMass = pendingPack[i];
            pendingDelta[i] = 0.0;
            pendingPack[i] = 0.0;

            const beforeHeight = delta[i];
            const beforePacking = packing[i];
            const m0 = Math.max(0.0, delta[i]);
            const m1 = m0 + mass;
            delta[i] = Math.min(SANDFIELD.maxDelta, delta[i] + mass);
            if (m1 > 1e-6) {
                packing[i] = Math.min(1.0, Math.max(0.0, (packing[i] * m0 + packMass) / m1));
            }
            heightChanged ||= delta[i] !== beforeHeight;
            materialChanged ||= packing[i] !== beforePacking;
        }

        if (heightChanged) {
            expandDirtyBox(rec, 0, SEG, 0, SEG);
            markHeight(rec);
        }
        if (materialChanged) markMaterial(rec);
    }

    function applyFlow(rec: ChunkRecordInternal, packRelax: number): void {
        const delta = rec.delta;
        const packing = rec.packing;
        let heightChanged = false;
        let materialChanged = false;

        for (let i = 0; i < CELLS; i++) {
            const beforeHeight = delta[i];
            const beforePacking = packing[i];
            const dm = flowMass[i];
            if (dm !== 0.0) {
                const m0 = Math.max(0.0, stateMass[i]);
                const m1 = m0 + dm;
                const packMass = statePack[i] * m0 + flowPack[i];

                delta[i] = Math.min(
                    SANDFIELD.maxDelta,
                    Math.max(-SANDFIELD.maxDelta, stateMass[i] + dm)
                );
                if (m1 > 1e-6) {
                    packing[i] = Math.min(1.0, Math.max(0.0, packMass / m1));
                }
            }

            if (packing[i] > 0.002) {
                const next = packing[i] * packRelax;
                packing[i] = next < 0.002 ? 0.0 : next;
            }
            heightChanged ||= delta[i] !== beforeHeight;
            materialChanged ||= packing[i] !== beforePacking;
        }

        if (heightChanged) {
            expandDirtyBox(rec, 0, SEG, 0, SEG);
            markHeight(rec);
        }
        if (materialChanged) markMaterial(rec);
    }

    // Двумерный векторный перенос ветра с осаждением в колеях и за препятствиями
    function transportChunk(rec: ChunkRecordInternal, dt: number, windX: number, windZ: number, erosionRate: number): void {
        if (rec.pendingDelta) absorbSeam(rec);
        if (!rec.touched) return;

        const k = 1 - Math.exp(-erosionRate * dt);
        const packRelax = Math.exp(-SANDFIELD.relaxPacking * dt);

        const windSpeed = Math.hypot(windX, windZ);
        if (windSpeed <= 1e-5) return;

        const delta = rec.delta;
        const packing = rec.packing;

        stateMass.set(delta);
        statePack.set(packing);
        flowMass.fill(0);
        flowPack.fill(0);

        let shearChanged = false;

        // Векторные компоненты и доли потока по осям X и Z
        const absX = Math.abs(windX);
        const absZ = Math.abs(windZ);
        const sumAbs = absX + absZ || 1.0;
        const fracX = absX / sumAbs;
        const fracZ = absZ / sumAbs;
        const stepCol = Math.sign(windX);
        const stepRow = Math.sign(windZ);
        const wDiag = (stepCol !== 0 && stepRow !== 0) ? Math.min(fracX, fracZ) : 0.0;
        const wX = fracX - wDiag * 0.5;
        const wZ = fracZ - wDiag * 0.5;

        function transferMass(fromIndex: number, tCol: number, tRow: number, flowAmt: number, packVal: number): void {
            if (flowAmt <= 1e-7) return;
            if (tCol >= 0 && tCol <= SEG && tRow >= 0 && tRow <= SEG) {
                const target = tRow * N + tCol;
                const room = Math.max(0.0, SANDFIELD.maxDelta - delta[target]);
                const moved = Math.min(flowAmt, room);
                if (moved > 1e-6) {
                    flowMass[fromIndex] -= moved;
                    flowPack[fromIndex] -= moved * packVal;
                    flowMass[target] += moved;
                    flowPack[target] += moved * packVal;
                }
            } else {
                const moved = pushSeam(rec, tCol, tRow, flowAmt, packVal);
                if (moved > 1e-6) {
                    flowMass[fromIndex] -= moved;
                    flowPack[fromIndex] -= moved * packVal;
                }
            }
        }

        for (let row = 0; row < N; row++) {
            for (let col = 0; col < N; col++) {
                const index = row * N + col;
                const value = delta[index];
                if (value <= 1e-4) continue;

                // Затенение в воронках / колеях и сопротивление сдуву от уплотнения (порог срыва)
                const rutShelter = value < 0
                    ? Math.max(0.12, 1.0 - Math.min(0.88, (-value) * (SANDFIELD.rutShelterGain || 1.4)))
                    : 1.0;
                const packResist = 1.0 + packing[index] * 0.55;

                const amount = (value * k * rutShelter) / packResist;
                if (amount <= 1e-6) continue;

                // Дробный 2D-векторный перенос: перенос по X, по Z и диагональный поток
                if (stepCol !== 0 && wX > 1e-6) {
                    transferMass(index, col + stepCol, row, amount * wX, packing[index]);
                }
                if (stepRow !== 0 && wZ > 1e-6) {
                    transferMass(index, col, row + stepRow, amount * wZ, packing[index]);
                }
                if (wDiag > 1e-6) {
                    transferMass(index, col + stepCol, row + stepRow, amount * wDiag, packing[index]);
                }

                if (rec.slipX && rec.slipZ) {
                    const sx = Math.fround(windX * k);
                    const sz = Math.fround(windZ * k);
                    shearChanged ||= rec.slipX[index] !== sx || rec.slipZ[index] !== sz;
                    rec.slipX[index] = sx;
                    rec.slipZ[index] = sz;
                }
            }
        }

        if (shearChanged) markMaterial(rec);
        applyFlow(rec, packRelax);
    }

    function relaxSlopes(rec: ChunkRecordInternal, dt: number): void {
        if (!rec.touched) return;

        const delta = rec.delta;
        const packing = rec.packing;
        const repose = SANDFIELD.reposeSlope * CELL;

        stateMass.set(delta);
        statePack.set(packing);
        flowMass.fill(0);
        flowPack.fill(0);

        let maxShift = 0.0;

        for (let row = 1; row < SEG; row++) {
            for (let col = 1; col < SEG; col++) {
                const index = row * N + col;
                const h = delta[index];
                if (h <= 1e-4) continue;

                let budget = h * 0.5;

                for (let d = 0; d < 4 && budget > 1e-6; d++) {
                    const nc = col + (d === 0 ? 1 : (d === 1 ? -1 : 0));
                    const nr = row + (d === 2 ? 1 : (d === 3 ? -1 : 0));
                    const ni = nr * N + nc;
                    const drop = h - delta[ni] - repose;
                    if (drop <= 1e-6) continue;

                    const room = SANDFIELD.maxDelta - delta[ni] - Math.max(0.0, flowMass[ni]);
                    if (room <= 1e-6) continue;

                    const amount = Math.min(
                        budget,
                        SANDFIELD.reposeMobility * drop * dt,
                        room
                    );
                    if (amount <= 1e-6) continue;

                    budget -= amount;
                    flowMass[index] -= amount;
                    flowPack[index] -= amount * packing[index];
                    flowMass[ni] += amount;
                    flowPack[ni] += amount * packing[index];
                    if (amount > maxShift) maxShift = amount;
                }
            }
        }

        if (maxShift <= 1e-7) return;
        applyFlow(rec, 1.0);
    }

    // Изъятие массы из поля песка (L1) для передачи в гранулы (L2)
    function withdrawMass(x: number, z: number, amount: number): number {
        if (amount <= 1e-7) return 0;
        const rec = recordAt(x, z) || recordFor(chunkCoordAt(x), chunkCoordAt(z));
        const colF = (x - rec.originX + HALF) / CELL;
        const rowF = (z - rec.originZ + HALF) / CELL;
        const c = Math.round(colF);
        const r = Math.round(rowF);
        if (c < 0 || c > SEG || r < 0 || r > SEG) {
            if (worldReserve >= amount) {
                worldReserve -= amount;
                return amount;
            }
            const avail = worldReserve;
            worldReserve = 0;
            return avail;
        }

        const idx = r * N + c;
        const cellArea = CELL * CELL;
        const availHeight = Math.max(0, rec.delta[idx] - (-SANDFIELD.maxSinkDepth));
        const availVol = availHeight * cellArea;

        let takenVol = 0;
        if (availVol >= amount) {
            takenVol = amount;
            rec.delta[idx] -= amount / cellArea;
            rec.touched = true;
            expandDirtyBox(rec, c, c, r, r);
            markHeight(rec);
            return takenVol;
        }

        if (availVol > 1e-6) {
            takenVol += availVol;
            rec.delta[idx] = -SANDFIELD.maxSinkDepth;
            rec.touched = true;
            expandDirtyBox(rec, c, c, r, r);
            markHeight(rec);
        }

        let needed = amount - takenVol;
        if (needed > 1e-6) {
            for (let k = 0; k < 8; k++) {
                const nc = c + NB_DC[k];
                const nr = r + NB_DR[k];
                if (nc >= 0 && nc <= SEG && nr >= 0 && nr <= SEG) {
                    const nIdx = nr * N + nc;
                    const nAvailH = Math.max(0, rec.delta[nIdx] - (-SANDFIELD.maxSinkDepth));
                    const nAvailV = nAvailH * cellArea;
                    if (nAvailV > 1e-6) {
                        const take = Math.min(nAvailV, needed);
                        rec.delta[nIdx] -= take / cellArea;
                        rec.touched = true;
                        expandDirtyBox(rec, nc, nc, nr, nr);
                        markHeight(rec);
                        takenVol += take;
                        needed -= take;
                        if (needed <= 1e-6) break;
                    }
                }
            }
        }

        return takenVol;
    }

    // Осаждение массы от гранул (L2) в поле (L1) с каскадным перераспределением
    function depositMass(x: number, z: number, amount: number): number {
        if (amount <= 1e-7) return 0;
        const rec = recordAt(x, z) || recordFor(chunkCoordAt(x), chunkCoordAt(z));
        const colF = (x - rec.originX + HALF) / CELL;
        const rowF = (z - rec.originZ + HALF) / CELL;
        const c = Math.round(colF);
        const r = Math.round(rowF);
        if (c < 0 || c > SEG || r < 0 || r > SEG) {
            worldReserve += amount;
            return amount;
        }

        const idx = r * N + c;
        const cellArea = CELL * CELL;
        const roomH = Math.max(0, SANDFIELD.maxDelta - rec.delta[idx]);
        const roomVol = roomH * cellArea;

        if (amount <= roomVol) {
            rec.delta[idx] += amount / cellArea;
            rec.touched = true;
            expandDirtyBox(rec, c, c, r, r);
            markHeight(rec);
            return amount;
        }

        let placedVol = 0;
        if (roomVol > 1e-6) {
            rec.delta[idx] = SANDFIELD.maxDelta;
            rec.touched = true;
            expandDirtyBox(rec, c, c, r, r);
            markHeight(rec);
            placedVol += roomVol;
        }

        let excess = amount - placedVol;
        for (let k = 0; k < 8; k++) {
            const nc = c + NB_DC[k];
            const nr = r + NB_DR[k];
            if (nc >= 0 && nc <= SEG && nr >= 0 && nr <= SEG) {
                const nIdx = nr * N + nc;
                const nRoomH = Math.max(0, SANDFIELD.maxDelta - rec.delta[nIdx]);
                const nRoomV = nRoomH * cellArea;
                if (nRoomV > 1e-6) {
                    const put = Math.min(nRoomV, excess);
                    rec.delta[nIdx] += put / cellArea;
                    rec.touched = true;
                    expandDirtyBox(rec, nc, nc, nr, nr);
                    markHeight(rec);
                    placedVol += put;
                    excess -= put;
                    if (excess <= 1e-7) break;
                }
            }
        }

        if (excess > 1e-7) {
            worldReserve += excess;
            placedVol += excess;
        }

        return placedVol;
    }

    function addReserve(amount: number): void {
        if (amount > 0) worldReserve += amount;
    }

    function getWorldReserve(): number {
        return worldReserve;
    }

    function setWorldReserve(amount: number): void {
        worldReserve = Math.max(0, amount || 0);
    }

    function update(
        dt: number,
        { windX = 0, windZ = 0, erosionRate = null, intensity = null }: {
            windX?: number;
            windZ?: number;
            erosionRate?: number | null;
            intensity?: number | null;
        } = {}
    ): void {
        if (pinned.length === 0 || dt <= 0) return;
        const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

        const effectiveErosion = erosionRate !== null
            ? erosionRate
            : (intensity !== null ? intensity * (SANDFIELD as any).windErosion : 0.0);

        reposeAccum += dt;
        while (reposeAccum >= SANDFIELD.reposeInterval) {
            reposeAccum -= SANDFIELD.reposeInterval;
            const perTick = Math.min(SANDFIELD.reposeChunksPerTick, pinned.length);
            for (let n = 0; n < perTick; n++) {
                const key = pinned[reposeCursor];
                reposeCursor = (reposeCursor + 1) % pinned.length;
                const rec = chunks.get(key);
                if (rec && rec.attached) relaxSlopes(rec, SANDFIELD.reposeInterval);
            }
        }

        const saltation = Math.max(0, Math.hypot(windX, windZ) - SANDFIELD.saltationThreshold);
        const rate = effectiveErosion * (1.0 + saltation * SANDFIELD.transportGain);
        if (rate <= 0) {
            windAccum = 0;
            lastStepDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
            return;
        }

        windAccum += dt;
        const tickDt = SANDFIELD.windInterval;
        const perTick = Math.min(SANDFIELD.windChunksPerTick, pinned.length);
        let ticks = 0;

        while (windAccum >= tickDt && ticks < 4) {
            windAccum -= tickDt;
            ticks++;
            for (let n = 0; n < perTick; n++) {
                const key = pinned[transportCursor];
                transportCursor = (transportCursor + 1) % pinned.length;
                const rec = chunks.get(key);
                if (rec) transportChunk(rec, tickDt, windX, windZ, rate);
            }
        }
        if (windAccum > tickDt * 4) windAccum = 0;
        lastStepDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    // --- Диагностика и статистика -----------------------------------------

    function getStats(): SandFieldStats {
        let deltas = 0;
        let packed = 0;
        for (const key of pinned) {
            const rec = chunks.get(key);
            if (!rec || !rec.touched) continue;
            for (let i = 0; i < CELLS; i += 16) {
                if (rec.delta[i] !== 0) deltas++;
                if (rec.packing[i] > 0.35) packed++;
            }
        }
        return {
            chunks: chunks.size,
            attached: pinned.length,
            dirty: heightDirty.size,
            materialDirty: materialDirty.size,
            contactDirty: contactDirty.size,
            physicsDirty: physicsDirty.size,
            deformed: deltas,
            packed,
            evictedChunks: evictedStore.size,
            worldReserve,
            stepDurationMs: lastStepDurationMs,
            syncLatencyMs,
            lastSyncDurationMs
        };
    }

    // Полный баланс объёма по всей системе (активные, кэшированные и вытесненные)
    function getTotalVolume(): number {
        let total = 0.0;
        for (const rec of chunks.values()) {
            for (let i = 0; i < CELLS; i++) total += rec.delta[i];
            if (rec.pendingDelta) {
                for (let i = 0; i < CELLS; i++) total += rec.pendingDelta[i];
            }
        }
        for (const saved of evictedStore.values()) {
            for (let i = 0; i < CELLS; i++) total += saved.delta[i];
        }
        return total * CELL * CELL + worldReserve;
    }

    function getRecord(key: string): ChunkRecordInternal | undefined {
        return chunks.get(key);
    }

    function getDirtyBounds(key: string): DirtyBounds | null {
        const rec = chunks.get(key);
        if (!rec || !rec.hasDirtyRegion) return null;
        const bounds = {
            minCol: rec.dirtyMinCol,
            maxCol: rec.dirtyMaxCol,
            minRow: rec.dirtyMinRow,
            maxRow: rec.dirtyMaxRow
        };
        rec.hasDirtyRegion = false;
        rec.dirtyMinCol = SEG;
        rec.dirtyMaxCol = 0;
        rec.dirtyMinRow = SEG;
        rec.dirtyMaxRow = 0;
        return bounds;
    }

    return {
        attachChunk,
        detachChunk,
        sampleDelta,
        samplePacking,
        sampleHeight,
        sampleNormal,
        contact,
        land,
        stampCrater,
        stampSole,
        soleFootprintInChunk,
        withdrawMass,
        depositMass,
        addReserve,
        getWorldReserve,
        setWorldReserve,
        consumeDirty,
        consumeVisualDirty,
        consumeContactDirty,
        consumePhysicsDirty,
        getDirtyBounds,
        update,
        getRecord,
        getStats,
        getTotalVolume
    };
}

export type SandField = ReturnType<typeof createSandField>;

