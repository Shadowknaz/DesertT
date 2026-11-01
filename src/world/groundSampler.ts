// Выборка верхнего слоя грунта с поддержкой классификации материалов.
// Возвращает высоту, нормаль, тип поверхности (sand/solid), классифицированный материал
// (loose_sand, compacted_sand, dense_layer, stone, bedrock), допустимый угол контакта и террамеханические свойства.
import * as THREE from 'three';
import { RAPIER } from './physics.ts';
import { COSMO, SAND, SANDFIELD, TERRAIN } from '../config.ts';
import { getDuneHeight, getDuneNormal } from '../core/duneField.ts';
import { classifySoilMaterial, SOIL_MATERIALS } from './terramechanics.ts';

export interface GroundSamplerResult {
    y: number;
    normal: THREE.Vector3;
    surfaceType: 'sand' | 'solid';
    colliderHandle: number | null;
    packing: number;
    friction: number;
    sink: number;
    materialId: string;
    cohesion: number;
    frictionAngleDeg: number;
    bearingCapacity: number;
    maxContactAngle: number;
}

export type GroundSample = GroundSamplerResult;

export interface CharacterGroundProbes {
    center: GroundSample;
    leftFoot: GroundSample;
    rightFoot: GroundSample;
    ahead: GroundSample;
    behind: GroundSample;
}

export interface GroundSamplerOptions {
    world: RAPIER.World;
    mechBodies?: RAPIER.RigidBody | RAPIER.RigidBody[] | any;
    ignoredBodyHandles?: Set<number> | Iterable<number>;
    sandField?: {
        sampleDelta(x: number, z: number): number;
        samplePacking(x: number, z: number): number;
        sampleNormal(x: number, z: number, baseNormal: THREE.Vector3, outNormal: THREE.Vector3): THREE.Vector3;
    } | null;
}

export interface GroundSampler {
    sample(x: number, z: number, referenceY?: number): GroundSamplerResult;
    ignoreBody(bodyOrHandle: RAPIER.RigidBody | number | { handle: number } | any): void;
}

const DEFAULT_SAND_MAX_ANGLE = 40 * Math.PI / 180;
const DEFAULT_PACKED_BONUS_RAD = 5 * Math.PI / 180;
const DEFAULT_SOLID_MAX_ANGLE = Math.max(COSMO.maxSlopeClimbAngle ?? 0, 58 * Math.PI / 180);

export function computeMaxContactAngle(
    surfaceType: 'sand' | 'solid' | string,
    materialId: string,
    packing: number
): number {
    if (surfaceType === 'solid' || materialId === 'stone' || materialId === 'bedrock') {
        return DEFAULT_SOLID_MAX_ANGLE;
    }
    const clampedPacking = THREE.MathUtils.clamp(packing || 0, 0, 1);
    if (materialId === 'compacted_sand' || materialId === 'dense_layer') {
        return Math.min(DEFAULT_SOLID_MAX_ANGLE, DEFAULT_SAND_MAX_ANGLE + DEFAULT_PACKED_BONUS_RAD * Math.max(0.5, clampedPacking));
    }
    return Math.min(DEFAULT_SOLID_MAX_ANGLE, DEFAULT_SAND_MAX_ANGLE + DEFAULT_PACKED_BONUS_RAD * clampedPacking);
}

export function createDefaultGroundSample(y = 0): GroundSample {
    return {
        y,
        normal: new THREE.Vector3(0, 1, 0),
        surfaceType: 'sand',
        colliderHandle: null,
        packing: 0,
        friction: SANDFIELD.gripLoose,
        sink: 0,
        materialId: 'loose_sand',
        cohesion: SOIL_MATERIALS.loose_sand.cohesion,
        frictionAngleDeg: SOIL_MATERIALS.loose_sand.frictionAngleDeg,
        bearingCapacity: SOIL_MATERIALS.loose_sand.bearingCapacityBase,
        maxContactAngle: computeMaxContactAngle('sand', 'loose_sand', 0)
    };
}

export function copyGroundSample(
    source: GroundSamplerResult,
    target: Partial<GroundSamplerResult> & { normal: THREE.Vector3 } = { normal: new THREE.Vector3() }
): GroundSamplerResult {
    const normal = target.normal;
    Object.assign(target, source);
    target.normal = normal.copy(source.normal);
    if (typeof target.maxContactAngle !== 'number') {
        target.maxContactAngle = computeMaxContactAngle(
            target.surfaceType || 'sand',
            target.materialId || 'loose_sand',
            target.packing ?? 0
        );
    }
    return target as GroundSamplerResult;
}

function rawHeightFromQuery(groundAt: any, x: number, z: number, fallbackY = 0, referenceY?: number): number {
    if (typeof groundAt !== 'function') return fallbackY;
    const s = groundAt(x, z, referenceY);
    if (typeof s === 'number') return Number.isFinite(s) ? s : fallbackY;
    if (s && typeof s.y === 'number' && Number.isFinite(s.y)) return s.y;
    return fallbackY;
}

/**
 * Приводит любой результат groundAt (полный GroundSample, частичный объект или число высоты)
 * к единому валидному GroundSample с нормалью, трением, уплотнением, осадкой и допустимым углом контакта.
 */
export function resolveGroundSample(
    groundAt: any,
    x: number,
    z: number,
    out: GroundSample = createDefaultGroundSample(),
    computeMissingNormal = true,
    referenceY?: number
): GroundSample {
    if (typeof groundAt !== 'function') {
        out.y = 0;
        out.normal.set(0, 1, 0);
        out.surfaceType = 'sand';
        out.colliderHandle = null;
        out.packing = 0;
        out.friction = SANDFIELD.gripLoose;
        out.sink = 0;
        out.materialId = 'loose_sand';
        out.cohesion = SOIL_MATERIALS.loose_sand.cohesion;
        out.frictionAngleDeg = SOIL_MATERIALS.loose_sand.frictionAngleDeg;
        out.bearingCapacity = SOIL_MATERIALS.loose_sand.bearingCapacityBase;
        out.maxContactAngle = computeMaxContactAngle('sand', 'loose_sand', 0);
        return out;
    }

    const raw = groundAt(x, z, referenceY);
    if (typeof raw === 'number') {
        out.y = Number.isFinite(raw) ? raw : 0;
        out.surfaceType = 'sand';
        out.colliderHandle = null;
        out.packing = 0;
        out.friction = SANDFIELD.gripLoose;
        out.sink = 0;
        out.materialId = 'loose_sand';
        out.cohesion = SOIL_MATERIALS.loose_sand.cohesion;
        out.frictionAngleDeg = SOIL_MATERIALS.loose_sand.frictionAngleDeg;
        out.bearingCapacity = SOIL_MATERIALS.loose_sand.bearingCapacityBase;
        out.maxContactAngle = computeMaxContactAngle('sand', 'loose_sand', 0);
        if (computeMissingNormal) {
            const eps = 0.30;
            const hXP = rawHeightFromQuery(groundAt, x + eps, z, out.y, referenceY);
            const hXN = rawHeightFromQuery(groundAt, x - eps, z, out.y, referenceY);
            const hZP = rawHeightFromQuery(groundAt, x, z + eps, out.y, referenceY);
            const hZN = rawHeightFromQuery(groundAt, x, z - eps, out.y, referenceY);
            const nx = (hXN - hXP) / (2 * eps);
            const nz = (hZN - hZP) / (2 * eps);
            out.normal.set(nx, 1.0, nz).normalize();
        } else {
            out.normal.set(0, 1, 0);
        }
        return out;
    }

    if (raw && typeof raw.y === 'number') {
        out.y = Number.isFinite(raw.y) ? raw.y : 0;
        const surfaceType: 'sand' | 'solid' = raw.surfaceType === 'solid' ? 'solid' : 'sand';
        out.surfaceType = surfaceType;
        out.colliderHandle = raw.colliderHandle ?? null;
        out.packing = typeof raw.packing === 'number' && Number.isFinite(raw.packing)
            ? THREE.MathUtils.clamp(raw.packing, 0, 1)
            : 0;
        out.sink = typeof raw.sink === 'number' && Number.isFinite(raw.sink)
            ? Math.max(0, raw.sink)
            : 0;
        out.materialId = raw.materialId || (surfaceType === 'solid' ? 'stone' : 'loose_sand');
        const matDef = (SOIL_MATERIALS as any)[out.materialId] || (surfaceType === 'solid' ? SOIL_MATERIALS.stone : SOIL_MATERIALS.loose_sand);
        out.friction = typeof raw.friction === 'number' && Number.isFinite(raw.friction)
            ? raw.friction
            : (surfaceType === 'solid'
                ? 0.9
                : SANDFIELD.gripLoose + (SANDFIELD.gripPacked - SANDFIELD.gripLoose) * out.packing);
        out.cohesion = typeof raw.cohesion === 'number' ? raw.cohesion : matDef.cohesion;
        out.frictionAngleDeg = typeof raw.frictionAngleDeg === 'number' ? raw.frictionAngleDeg : matDef.frictionAngleDeg;
        out.bearingCapacity = typeof raw.bearingCapacity === 'number' ? raw.bearingCapacity : matDef.bearingCapacityBase;
        out.maxContactAngle = typeof raw.maxContactAngle === 'number' && Number.isFinite(raw.maxContactAngle)
            ? raw.maxContactAngle
            : computeMaxContactAngle(surfaceType, out.materialId, out.packing);

        if (raw.normal && typeof raw.normal.x === 'number' && Number.isFinite(raw.normal.x) && Number.isFinite(raw.normal.y) && Number.isFinite(raw.normal.z)) {
            out.normal.set(raw.normal.x, Math.max(0.05, raw.normal.y), raw.normal.z);
            if (out.normal.lengthSq() > 1e-6) {
                out.normal.normalize();
            } else {
                out.normal.set(0, 1, 0);
            }
        } else if (computeMissingNormal) {
            const eps = 0.30;
            const hXP = rawHeightFromQuery(groundAt, x + eps, z, out.y, referenceY);
            const hXN = rawHeightFromQuery(groundAt, x - eps, z, out.y, referenceY);
            const hZP = rawHeightFromQuery(groundAt, x, z + eps, out.y, referenceY);
            const hZN = rawHeightFromQuery(groundAt, x, z - eps, out.y, referenceY);
            const nx = (hXN - hXP) / (2 * eps);
            const nz = (hZN - hZP) / (2 * eps);
            out.normal.set(nx, 1.0, nz).normalize();
        } else {
            out.normal.set(0, 1, 0);
        }
        return out;
    }

    out.y = 0;
    out.normal.set(0, 1, 0);
    out.surfaceType = 'sand';
    out.colliderHandle = null;
    out.packing = 0;
    out.friction = SANDFIELD.gripLoose;
    out.sink = 0;
    out.materialId = 'loose_sand';
    out.cohesion = SOIL_MATERIALS.loose_sand.cohesion;
    out.frictionAngleDeg = SOIL_MATERIALS.loose_sand.frictionAngleDeg;
    out.bearingCapacity = SOIL_MATERIALS.loose_sand.bearingCapacityBase;
    out.maxContactAngle = computeMaxContactAngle('sand', 'loose_sand', 0);
    return out;
}

export function createCharacterGroundProbes(): CharacterGroundProbes {
    return {
        center: createDefaultGroundSample(),
        leftFoot: createDefaultGroundSample(),
        rightFoot: createDefaultGroundSample(),
        ahead: createDefaultGroundSample(),
        behind: createDefaultGroundSample()
    };
}

/**
 * Сэмплирует 5 опорных точек поверхности вокруг персонажа:
 * - под центром капсулы (center)
 * - под левой стопой (leftFoot)
 * - под правой стопой (rightFoot)
 * - впереди по курсу/движению (ahead)
 * - позади для оценки спуска и перехода через гребень (behind)
 */
export function sampleCharacterGroundProbes(
    groundAt: any,
    x: number,
    z: number,
    dirX: number,
    dirZ: number,
    rightX: number,
    rightZ: number,
    config: Partial<typeof COSMO> = COSMO,
    out: CharacterGroundProbes = createCharacterGroundProbes(),
    referenceY?: number
): CharacterGroundProbes {
    const footOffset = config.probeFootOffsetX ?? COSMO.probeFootOffsetX ?? 0.19;
    const aheadDist = config.probeAheadDistance ?? COSMO.probeAheadDistance ?? 0.42;
    const behindDist = config.probeBehindDistance ?? COSMO.probeBehindDistance ?? 0.36;

    resolveGroundSample(groundAt, x, z, out.center, true, referenceY);
    resolveGroundSample(
        groundAt,
        x - rightX * footOffset,
        z - rightZ * footOffset,
        out.leftFoot,
        true,
        referenceY
    );
    resolveGroundSample(
        groundAt,
        x + rightX * footOffset,
        z + rightZ * footOffset,
        out.rightFoot,
        true,
        referenceY
    );
    resolveGroundSample(
        groundAt,
        x + dirX * aheadDist,
        z + dirZ * aheadDist,
        out.ahead,
        false,
        referenceY
    );
    resolveGroundSample(
        groundAt,
        x - dirX * behindDist,
        z - dirZ * behindDist,
        out.behind,
        false,
        referenceY
    );

    return out;
}

export function createGroundSampler({ world, mechBodies, ignoredBodyHandles, sandField = null }: GroundSamplerOptions): GroundSampler {
    const ray = new RAPIER.Ray({ x: 0, y: TERRAIN.probeOriginY, z: 0 }, { x: 0, y: -1, z: 0 });
    const result: GroundSamplerResult = {
        y: 0, normal: new THREE.Vector3(0, 1, 0),
        surfaceType: 'sand', colliderHandle: null,
        packing: 0, friction: SANDFIELD.gripLoose, sink: 0,
        materialId: 'loose_sand',
        cohesion: SOIL_MATERIALS.loose_sand.cohesion,
        frictionAngleDeg: SOIL_MATERIALS.loose_sand.frictionAngleDeg,
        bearingCapacity: SOIL_MATERIALS.loose_sand.bearingCapacityBase,
        maxContactAngle: computeMaxContactAngle('sand', 'loose_sand', 0)
    };
    const baseNormal = new THREE.Vector3(0, 1, 0);

    const bodies = (Array.isArray(mechBodies) ? mechBodies : [mechBodies]).filter(Boolean);
    const ignored = ignoredBodyHandles instanceof Set
        ? ignoredBodyHandles
        : new Set(ignoredBodyHandles || []);
    for (const body of bodies) {
        if (body && body.handle !== undefined) ignored.add(body.handle);
    }

    function sampleSand(x: number, z: number, colliderHandle: number | null): GroundSamplerResult {
        const deform = Boolean(sandField && SAND.physicalFootprints);
        const delta = deform && sandField ? sandField.sampleDelta(x, z) : 0;
        const duneY = getDuneHeight(x, z);
        result.surfaceType = 'sand';
        result.colliderHandle = colliderHandle;
        result.y = duneY + delta;
        result.packing = sandField ? sandField.samplePacking(x, z) : 0;
        result.friction = SANDFIELD.gripLoose
            + (SANDFIELD.gripPacked - SANDFIELD.gripLoose) * result.packing;
        result.sink = Math.max(0, -delta);

        getDuneNormal(x, z, 0.35, baseNormal);
        if (deform && sandField) sandField.sampleNormal(x, z, baseNormal, result.normal);
        else result.normal.copy(baseNormal);

        // Классификация материала
        const slope = Math.hypot(result.normal.x, result.normal.z) / Math.max(0.1, result.normal.y);
        const mat = classifySoilMaterial(result.packing, result.sink, false, slope, result.y);
        result.materialId = mat.id;
        result.cohesion = mat.cohesion;
        result.frictionAngleDeg = mat.frictionAngleDeg;
        result.bearingCapacity = mat.bearingCapacityBase;
        result.maxContactAngle = computeMaxContactAngle('sand', result.materialId, result.packing);

        return result;
    }

    function sample(x: number, z: number, referenceY?: number): GroundSamplerResult {
        const useRefY = typeof referenceY === 'number' && Number.isFinite(referenceY);
        ray.origin.x = x;
        ray.origin.y = useRefY ? referenceY + 1.45 : TERRAIN.probeOriginY;
        ray.origin.z = z;
        const wallHandles: Set<number> | undefined = (world as any).__wallColliderHandles;

        const hit = world.castRayAndGetNormal(
            ray,
            TERRAIN.probeRange,
            true,
            undefined,
            undefined,
            undefined,
            bodies[0],
            (collider: any) => {
                if (wallHandles && wallHandles.has(collider.handle)) return false;
                if (typeof collider.isSensor === 'function' && collider.isSensor()) return false;
                const parent = collider.parent();
                if (parent && ignored.has(parent.handle)) return false;
                // Капсульные коллайдеры принадлежат управляемым персонажам и не являются поверхностью грунта
                if (collider.shape.type === RAPIER.ShapeType.Capsule) return false;
                return true;
            }
        );

        if (hit && hit.toi > 0.05) {
            const collider = hit.collider;
            if (collider.shape.type === RAPIER.ShapeType.HeightField) {
                return sampleSand(x, z, collider.handle);
            }
            result.surfaceType = 'solid';
            result.colliderHandle = collider.handle;
            result.y = ray.pointAt(hit.toi).y;
            result.packing = 0;
            result.sink = 0;
            result.friction = collider.friction();
            result.materialId = 'stone';
            result.cohesion = SOIL_MATERIALS.stone.cohesion;
            result.frictionAngleDeg = SOIL_MATERIALS.stone.frictionAngleDeg;
            result.bearingCapacity = SOIL_MATERIALS.stone.bearingCapacityBase;
            result.maxContactAngle = computeMaxContactAngle('solid', 'stone', 0);

            baseNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
            if (baseNormal.y < 0.35) baseNormal.set(0, 1, 0);
            result.normal.copy(baseNormal.normalize());
            return result;
        }

        return sampleSand(x, z, null);
    }

    function ignoreBody(bodyOrHandle: any): void {
        if (!bodyOrHandle) return;
        const handle = typeof bodyOrHandle === 'object' && bodyOrHandle !== null
            ? bodyOrHandle.handle
            : bodyOrHandle;
        if (handle !== undefined) ignored.add(handle);
    }

    return { sample, ignoreBody };
}
