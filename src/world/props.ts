// Реквизит одного чанка: детерминированные скалы со своими коллайдерами
// и динамические обломки, которые мех расталкивает лапами.
// Позиции выводятся из индексов чанка, поэтому мир воспроизводим при перезагрузке.
import * as THREE from 'three';
import { RAPIER } from './physics.ts';
import { CHUNK, DIORAMA } from '../config.ts';
import { hash2 } from '../core/noise.ts';
import { getDuneHeight, getDuneNormal, getMountainMask, getBiomeWeights } from '../core/duneField.ts';
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

export interface ChunkPropsMaterials {
    rock: THREE.Material;
    debris: THREE.Material;
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
    enabled = true
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

    const meshes: THREE.Mesh[] = [];
    const staticBodies: any[] = [];
    const debris: DebrisProp[] = [];

    // Определение биома и маски гор для геологически обоснованного спавна
    const biomes = getBiomeWeights(originX + halfSize, originZ + halfSize);
    const mountain = getMountainMask(originX + halfSize, originZ + halfSize);

    // --- Крупные скальные образования: валуны, плиты и ярданги ---
    // В Эрге скалы занесены толщей барханов, в горах и на месах их больше
    const rockChance = 1.4 * (1.0 - biomes.erg * 0.85) + mountain * 2.0 + biomes.mesa * 1.2;
    const rockCount = Math.floor(rng() * rockChance);

    for (let i = 0; i < rockCount; i++) {
        const lx = (rng() - 0.5) * (size - 7);
        const lz = (rng() - 0.5) * (size - 7);
        const groundX = originX + lx;
        const groundZ = originZ + lz;
        if (insideClearZone(groundX, groundZ, clearZone)) continue;

        const normal = getDuneNormal(groundX, groundZ);
        const slope = Math.hypot(normal.x, normal.z);
        // В чистом песке без уклона скалы не удерживаются
        if (biomes.erg > 0.4 && slope < 0.22) continue;

        // Выбор формы породы: валун, плита песчаника или ветровой ярданг
        const typeRoll = rng();
        let geom = rockGeometry;
        let sx = 1.6 + rng() * 1.5;
        let sy = 1.7 + rng() * 2.4;
        let sz = 1.6 + rng() * 1.3;

        if (biomes.mesa > 0.25 && typeRoll < 0.55 && slabGeometry) {
            geom = slabGeometry;
            sx = 2.0 + rng() * 1.6;
            sy = 0.8 + rng() * 0.6;
            sz = 2.0 + rng() * 1.6;
        }

        const h = getDuneHeight(groundX, groundZ);

        // Валун ложится по нормали склона и случайно доворачивается вокруг нее:
        // на крутых склонах скалы плотно сидят в породе и не висят краем.
        const tilt = new THREE.Quaternion().setFromUnitVectors(UP_AXIS, normal);
        const spin = new THREE.Quaternion().setFromAxisAngle(normal, rng() * Math.PI * 2);

        const mesh = new THREE.Mesh(geom, materials.rock);
        // У ярданга основание должно касаться поверхности, иначе нижняя часть
        // тонет в склоне и визуально оставляет один острый выступ.
        mesh.quaternion.copy(tilt).multiply(spin);
        mesh.scale.set(sx, sy, sz);
        mesh.position.set(groundX, h + supportOffset(geom, mesh.scale, mesh.quaternion) - 0.08, groundZ);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        meshes.push(mesh);

        const body = world.createRigidBody(
            RAPIER.RigidBodyDesc.fixed()
                .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
                .setRotation(mesh.quaternion)
        );
        world.createCollider(
            RAPIER.ColliderDesc.cuboid(sx * 0.7, sy * 0.7, sz * 0.7).setFriction(0.9),
            body
        );
        staticBodies.push(body);
    }

    // --- Редкий микро-реквизит: навигационные маркерные шесты экспедиций ---
    if (poleGeometry && rng() > 0.82) {
        const px = (rng() - 0.5) * (size - 10);
        const pz = (rng() - 0.5) * (size - 10);
        const poleX = originX + px;
        const poleZ = originZ + pz;
        if (!insideClearZone(poleX, poleZ, clearZone)) {
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

    // --- Динамические перекатывающиеся камни ---
    // В Реге (каменистой равнине) камней больше, в Эрге меньше
    const debrisBase = 2 + Math.floor(rng() * 3 + biomes.reg * 3 - biomes.erg * 1.5);
    const debrisCount = Math.max(1, Math.min(7, debrisBase));
    for (let i = 0; i < debrisCount; i++) {
        let lx = 0;
        let lz = 0;
        // Пара попыток не уронить обломок прямо на меха
        for (let attempt = 0; attempt < 4; attempt++) {
            lx = (rng() - 0.5) * (size - 5);
            lz = (rng() - 0.5) * (size - 5);
            if (!insideClearZone(originX + lx, originZ + lz, clearZone)) break;
        }

        const radius = 0.32 + rng() * 0.38;
        const h = getDuneHeight(originX + lx, originZ + lz);

        const mesh = new THREE.Mesh(debrisGeometry, materials.debris);
        mesh.scale.setScalar(radius);
        mesh.position.set(originX + lx, h + radius * 0.9, originZ + lz);
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

    // Синхронизация визуальных камней с физикой и удержание их внутри чанка.
    // Улетевший обломок возвращается на случайный склон этого же чанка.
    // Ветер толкает обломки импульсом за прошедшее время, поэтому сила
    // не зависит от числа подшагов физики в кадре.
    function update(wind: WeatherState | null, dt = 0.0): void {
        const localSpeed = wind ? Math.hypot(wind.windX, wind.windZ) : 0.0;
        const gust = wind ? wind.gust : 0.0;
        const invSpeed = localSpeed > 0.001 ? 1.0 / localSpeed : 0.0;
        // Ускорение от напора воздуха; порывы усиливают толчок
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
                prop.body.setTranslation({ x: nx, y: getDuneHeight(nx, nz) + prop.radius * 0.9, z: nz }, true);
                prop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                prop.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            }

            const pp = prop.body.translation();
            const pr = prop.body.rotation();
            prop.mesh.position.set(pp.x, pp.y, pp.z);
            prop.mesh.quaternion.set(pr.x, pr.y, pr.z, pr.w);
        });
    }

    // Взрыв толкает обломки: импульс падает к краю радиуса, а вверх
    // добавляется надбавка, чтобы камни не просто катились, а подлетали.
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
    }

    return { update, blastAt, dispose };
}

