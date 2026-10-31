// Выборка верхнего слоя грунта с поддержкой классификации материалов.
// Возвращает высоту, нормаль, тип поверхности (sand/solid), классифицированный материал
// (loose_sand, compacted_sand, dense_layer, stone, bedrock) и террамеханические свойства.
import * as THREE from 'three';
import { RAPIER } from './physics.ts';
import { SAND, SANDFIELD, TERRAIN } from '../config.ts';
import { getDuneHeight, getDuneNormal } from '../core/duneField.ts';
import { classifySoilMaterial, SOIL_MATERIALS, type SoilMaterial } from './terramechanics.ts';

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
}

export type GroundSample = GroundSamplerResult;

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
    sample(x: number, z: number): GroundSamplerResult;
    ignoreBody(bodyOrHandle: RAPIER.RigidBody | number | { handle: number } | any): void;
}

export function copyGroundSample(source: GroundSamplerResult, target: Partial<GroundSamplerResult> & { normal: THREE.Vector3 } = { normal: new THREE.Vector3() }): GroundSamplerResult {
    const normal = target.normal;
    Object.assign(target, source);
    target.normal = normal.copy(source.normal);
    return target as GroundSamplerResult;
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
        bearingCapacity: SOIL_MATERIALS.loose_sand.bearingCapacityBase
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

        baseNormal.copy(getDuneNormal(x, z));
        if (deform && sandField) sandField.sampleNormal(x, z, baseNormal, result.normal);
        else result.normal.copy(baseNormal);

        // Классификация материала
        const slope = Math.hypot(result.normal.x, result.normal.z) / Math.max(0.1, result.normal.y);
        const mat = classifySoilMaterial(result.packing, result.sink, false, slope, result.y);
        result.materialId = mat.id;
        result.cohesion = mat.cohesion;
        result.frictionAngleDeg = mat.frictionAngleDeg;
        result.bearingCapacity = mat.bearingCapacityBase;

        return result;
    }

    function sample(x: number, z: number): GroundSamplerResult {
        ray.origin.x = x;
        ray.origin.z = z;
        const hit = world.castRayAndGetNormal(
            ray,
            TERRAIN.probeRange,
            true,
            undefined,
            undefined,
            undefined,
            bodies[0],
            (collider: any) => {
                const parent = collider.parent();
                if (parent && ignored.has(parent.handle)) return false;
                // Капсульные коллайдеры принадлежат управляемым персонажам и не являются поверхностью грунта
                if (collider.shape.type === RAPIER.ShapeType.Capsule) return false;
                return true;
            }
        );

        if (hit && hit.toi > 0.1) {
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

            baseNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
            if (baseNormal.y < 0.5) baseNormal.set(0, 1, 0);
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
