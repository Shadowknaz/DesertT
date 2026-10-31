// Реквизит и геологическая детализация одного чанка:
// 1. Инстансированная россыпь мелкой пустынной гальки, щебня и обломков породы (InstancedMesh),
//    привязанная к каменистым почвам Рег и междюнному рельефу (без накладных расходов физики).
// 2. Полузасыпанные песком слоистые плиты песчаника и коренные выходы породы (InstancedMesh).
// 3. Крупные скальные образования (валуны, ярданги) со своими коллайдерами Rapier
//    и динамические перекатывающиеся камни.
import * as THREE from 'three';
import { RAPIER } from './physics.ts';
import { CHUNK, DIORAMA } from '../config.ts';
import { hash2 } from '../core/noise.ts';
import { getDuneHeight, getDuneNormal, getMountainMask, getBiomeWeights } from '../core/duneField.ts';
import { computeSoilWeightsAt } from './terrain.ts';
import type { WeatherState } from './weather.ts';

const UP_AXIS = new THREE.Vector3(0, 1, 0);

// Возвращает высоту опоры геометрии после масштаба и ориентации. Это не
// bounding sphere: для наклоненного валуна важен реальный нижний угол,
// иначе камень визуально висит над тем же аналитическим height(x, z).
function supportOffset(geometry: THREE.BufferGeometry, scale: THREE.Vector3, rotation: THREE.Quaternion): number {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) return 0.0;
    let minY = Number.POSITIVE_INFINITY;
    const corner = new THREE.Vector3();
    for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
                corner.set(x * scale.x, y * scale.y, z * scale.z).applyQuaternion(rotation);
                minY = Math.min(minY, corner.y);
            }
        }
    }
    return -minY;
}

// Линейный конгруэнтный генератор с зерном из координат чанка
function makeRng(cx: number, cz: number): () => number {
    let state = (hash2(cx * 12.9898 + 4.1, cz * 78.233 + 1.7) * 4294967296) | 0;
    return function next(): number {
        state = (state * 1664525 + 1013904223) | 0;
        return (state >>> 0) / 4294967296;
    };
}

export interface ClearZone {
    x: number;
    z: number;
    radius: number;
}

function insideClearZone(x: number, z: number, clearZone?: ClearZone | null): boolean {
    if (!clearZone) return false;
    const dx = x - clearZone.x;
    const dz = z - clearZone.z;
    return dx * dx + dz * dz < clearZone.radius * clearZone.radius;
}

// Коридор стартового движения возле (0, 0..22) остаётся свободным от крупных физических преград
function insideSpawnCorridor(x: number, z: number): boolean {
    return Math.abs(x) < 4.5 && z > -6.0 && z < 24.0;
}

export interface ChunkPropsMaterials {
    rock: THREE.Material;
    debris: THREE.Material;
    pebble?: THREE.Material;
}

export interface ChunkPropsOptions {
    scene: THREE.Scene;
    world: any;
    cx: number;
    cz: number;
    materials: ChunkPropsMaterials;
    rockGeometry: THREE.BufferGeometry;
    debrisGeometry: THREE.BufferGeometry;
    slabGeometry?: THREE.BufferGeometry;
    poleGeometry?: THREE.BufferGeometry;
    pebbleGeometry?: THREE.BufferGeometry;
    clearZone?: ClearZone | null;
    enabled?: boolean;
}

export interface DebrisProp {
    mesh: THREE.Mesh;
    body: any;
    radius: number;
}

export interface ChunkProps {
    update(wind: WeatherState | null, dt?: number): void;
    blastAt(origin: THREE.Vector3 | { x: number; y: number; z: number }, radius: number, strength: number): void;
    dispose(): void;
}

export function createChunkProps({
    scene,
    world,
    cx,
    cz,
    materials,
    rockGeometry,
    debrisGeometry,
    slabGeometry,
    poleGeometry,
    clearZone,
    enabled = false
}: ChunkPropsOptions): ChunkProps {
    if (!enabled) {
        return {
            update: () => {},
            blastAt: () => {},
            dispose: () => {}
        };
    }

    const size = CHUNK.size;
    const halfSize = size * 0.5;
    const originX = cx * size;
    const originZ = cz * size;
    const rng = makeRng(cx, cz);

    const meshes: THREE.Object3D[] = [];
    const instancedMeshes: THREE.InstancedMesh[] = [];
    const staticBodies: any[] = [];
    const debris: DebrisProp[] = [];

    // Определение биома и маски гор для геологически обоснованного спавна крупных скал
    const biomes = getBiomeWeights(originX + halfSize, originZ + halfSize);
    const mountain = getMountainMask(originX + halfSize, originZ + halfSize);

    // --- Крупные скальные образования ---
    const rockChance = 1.8 * (1.0 - biomes.erg * 0.65) + mountain * 2.2 + biomes.mesa * 1.4;
    const rockCount = Math.floor(rng() * rockChance + 0.35);

    for (let i = 0; i < rockCount; i++) {
        const lx = (rng() - 0.5) * (size - 7);
        const lz = (rng() - 0.5) * (size - 7);
        const groundX = originX + lx;
        const groundZ = originZ + lz;
        if (insideClearZone(groundX, groundZ, clearZone)) continue;
        if (insideSpawnCorridor(groundX, groundZ)) continue;

        const normal = getDuneNormal(groundX, groundZ);
        const slope = Math.hypot(normal.x, normal.z);
        const h = getDuneHeight(groundX, groundZ);
        const soil = computeSoilWeightsAt(groundX, groundZ, h, slope, 0.0);

        // В чистом песке без каменистой почвы и уклона крупные скалы редки
        if (biomes.erg > 0.55 && slope < 0.14 && soil.gravelReg < 0.25) continue;

        const typeRoll = rng();
        let geom = rockGeometry;
        let sx = 1.4 + rng() * 1.5;
        let sy = 1.2 + rng() * 2.1;
        let sz = 1.4 + rng() * 1.3;

        if ((biomes.mesa > 0.22 || soil.bareRock > 0.25) && typeRoll < 0.55 && slabGeometry) {
            geom = slabGeometry;
            sx = 1.8 + rng() * 1.6;
            sy = 0.65 + rng() * 0.65;
            sz = 1.8 + rng() * 1.6;
        }

        const tilt = new THREE.Quaternion().setFromUnitVectors(UP_AXIS, normal);
        const spin = new THREE.Quaternion().setFromAxisAngle(normal, rng() * Math.PI * 2);

        const mesh = new THREE.Mesh(geom, materials.rock);
        mesh.quaternion.copy(tilt).multiply(spin);
        mesh.scale.set(sx, sy, sz);
        mesh.position.set(groundX, h + supportOffset(geom, mesh.scale, mesh.quaternion) - 0.12, groundZ);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        meshes.push(mesh);

        // Вторичный прислонённый обломок породы у основания крупного валуна (составной силуэт)
        if (slabGeometry && rng() > 0.35) {
            const subAngle = rng() * Math.PI * 2;
            const subDist = Math.max(sx, sz) * 0.62;
            const subX = groundX + Math.cos(subAngle) * subDist;
            const subZ = groundZ + Math.sin(subAngle) * subDist;
            const subH = getDuneHeight(subX, subZ);
            const subMesh = new THREE.Mesh(slabGeometry, materials.rock);
            subMesh.scale.set(sx * 0.52, sy * 0.38, sz * 0.48);
            subMesh.quaternion.copy(tilt).multiply(
                new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.28)
            );
            subMesh.position.set(subX, subH + sy * 0.12, subZ);
            subMesh.castShadow = true;
            subMesh.receiveShadow = true;
            scene.add(subMesh);
            meshes.push(subMesh);
        }

        const body = world.createRigidBody(
            RAPIER.RigidBodyDesc.fixed()
                .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
                .setRotation(mesh.quaternion)
        );
        world.createCollider(
            RAPIER.ColliderDesc.cuboid(sx * 0.68, sy * 0.68, sz * 0.68).setFriction(0.9),
            body
        );
        staticBodies.push(body);
    }

    // --- 4. Редкий микро-реквизит: навигационные маркерные шесты экспедиций ---
    if (poleGeometry && rng() > 0.84) {
        const px = (rng() - 0.5) * (size - 10);
        const pz = (rng() - 0.5) * (size - 10);
        const poleX = originX + px;
        const poleZ = originZ + pz;
        if (!insideClearZone(poleX, poleZ, clearZone) && !insideSpawnCorridor(poleX, poleZ)) {
            const h = getDuneHeight(poleX, poleZ);
            const normal = getDuneNormal(poleX, poleZ);
            const poleTilt = new THREE.Quaternion().setFromUnitVectors(UP_AXIS, normal);
            const windLean = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0),
                0.12 + rng() * 0.1
            );
            poleTilt.multiply(windLean);

            const poleMesh = new THREE.Mesh(poleGeometry, materials.debris);
            poleMesh.position.set(poleX, h + 1.1, poleZ);
            poleMesh.quaternion.copy(poleTilt);
            poleMesh.castShadow = true;
            poleMesh.receiveShadow = true;
            scene.add(poleMesh);
            meshes.push(poleMesh);

            const poleBody = world.createRigidBody(
                RAPIER.RigidBodyDesc.fixed()
                    .setTranslation(poleMesh.position.x, poleMesh.position.y, poleMesh.position.z)
                    .setRotation(poleMesh.quaternion)
            );
            world.createCollider(
                RAPIER.ColliderDesc.cuboid(0.12, 1.3, 0.12).setFriction(0.8),
                poleBody
            );
            staticBodies.push(poleBody);
        }
    }

    // --- 5. Динамические перекатывающиеся камни ---
    const debrisBase = 2 + Math.floor(rng() * 3 + biomes.reg * 3 - biomes.erg * 1.2);
    const debrisCount = Math.max(1, Math.min(6, debrisBase));
    for (let i = 0; i < debrisCount; i++) {
        let lx = 0;
        let lz = 0;
        let validSpot = false;
        for (let attempt = 0; attempt < 6; attempt++) {
            lx = (rng() - 0.5) * (size - 5);
            lz = (rng() - 0.5) * (size - 5);
            const wx = originX + lx;
            const wz = originZ + lz;
            if (!insideClearZone(wx, wz, clearZone) && !insideSpawnCorridor(wx, wz)) {
                validSpot = true;
                break;
            }
        }
        if (!validSpot) continue;

        const radius = 0.28 + rng() * 0.34;
        const h = getDuneHeight(originX + lx, originZ + lz);

        const mesh = new THREE.Mesh(debrisGeometry, materials.debris);
        mesh.scale.setScalar(radius);
        mesh.position.set(originX + lx, h + radius * 0.85, originZ + lz);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        meshes.push(mesh);

        const body = world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic()
                .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
                .setLinearDamping(0.6)
                .setAngularDamping(0.8)
        );
        world.createCollider(
            RAPIER.ColliderDesc.ball(radius * 0.9)
                .setMass(1.8)
                .setFriction(0.95)
                .setRestitution(0.15),
            body
        );

        debris.push({ mesh, body, radius });
    }

    function update(wind: WeatherState | null, dt = 0.0): void {
        const localSpeed = wind ? Math.hypot(wind.windX, wind.windZ) : 0.0;
        const gust = wind ? wind.gust : 0.0;
        const invSpeed = localSpeed > 0.001 ? 1.0 / localSpeed : 0.0;
        const accel = localSpeed * (0.24 + gust * 0.22);
        const forceX = wind ? wind.windX * invSpeed * accel : 0.0;
        const forceZ = wind ? wind.windZ * invSpeed * accel : 0.0;

        debris.forEach(prop => {
            if (accel > 0.3 && dt > 0.0) {
                const mass = typeof prop.body.mass === 'function' ? prop.body.mass() : 1.8;
                prop.body.applyImpulse({ x: forceX * mass * dt, y: 0.0, z: forceZ * mass * dt }, true);
            }

            const p = prop.body.translation();
            const outOfChunk =
                Math.abs(p.x - originX) > halfSize - 1.1 ||
                Math.abs(p.z - originZ) > halfSize - 1.1 ||
                p.y < DIORAMA.baseBottom;

            if (outOfChunk) {
                const nx = originX + (rng() - 0.5) * (size - 8);
                const nz = originZ + (rng() - 0.5) * (size - 8);
                if (!insideClearZone(nx, nz, clearZone) && !insideSpawnCorridor(nx, nz)) {
                    prop.body.setTranslation({ x: nx, y: getDuneHeight(nx, nz) + prop.radius * 0.85, z: nz }, true);
                    prop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                    prop.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
                }
            }

            const pp = prop.body.translation();
            const pr = prop.body.rotation();
            prop.mesh.position.set(pp.x, pp.y, pp.z);
            prop.mesh.quaternion.set(pr.x, pr.y, pr.z, pr.w);
        });
    }

    function blastAt(origin: THREE.Vector3 | { x: number; y: number; z: number }, radius: number, strength: number): void {
        debris.forEach(prop => {
            const p = prop.body.translation();
            const dx = p.x - origin.x;
            const dy = p.y - origin.y;
            const dz = p.z - origin.z;
            const dist = Math.hypot(dx, dy, dz);
            if (dist >= radius) return;

            const falloff = 1.0 - dist / radius;
            const mass = typeof prop.body.mass === 'function' ? prop.body.mass() : 1.8;
            const invDist = 1.0 / Math.max(0.35, dist);
            const push = strength * falloff * mass;

            prop.body.applyImpulse({
                x: dx * invDist * push,
                y: (dy * invDist + 0.8) * push,
                z: dz * invDist * push
            }, true);
        });
    }

    function dispose(): void {
        debris.forEach(prop => {
            scene.remove(prop.mesh);
            world.removeRigidBody(prop.body);
        });
        staticBodies.forEach(body => world.removeRigidBody(body));
        meshes.forEach(mesh => scene.remove(mesh));
        instancedMeshes.forEach(inst => {
            scene.remove(inst);
            inst.dispose();
        });
    }

    return { update, blastAt, dispose };
}
