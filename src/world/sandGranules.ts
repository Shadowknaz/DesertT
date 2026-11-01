// Ближняя зернистая фаза песка (L2): активные прокси-гранулы возле лап и сопел.
// Зёрна выбиваются из-под подошвы при шаге, сдвиге и реактивной струе,
// летят по баллистической траектории с учётом ветра, соударяются с поверхностью
// L1 и при оседании возвращают свою массу обратно в активное поле песка.
import * as THREE from 'three';
import { PALETTE, PS1_SNAP } from '../config.ts';
import { applyPS1VertexSnap } from '../render/ps1Material.ts';
import { createRng, type Rng } from '../core/rng.ts';

const MAX_GRANULES = 4096;
const GRAVITY = 16.0;
const WIND_DRAG = 2.4;
const RESTITUTION = 0.22;
const GROUND_FRICTION = 0.65;
const SETTLE_SPEED_SQ = 0.12 * 0.12;

export interface SandGranulesOptions {
    scene: THREE.Scene;
    rng?: Rng;
    withdrawMass?: ((x: number, z: number, reqVol: number) => number) | null;
    depositMass?: ((x: number, z: number, volume: number) => number) | null;
    sampleHeight?: ((x: number, z: number) => number) | null;
    sampleGround?: ((x: number, z: number) => any) | null;
    addReserve?: ((vol: number) => void) | null;
}

export interface GranulesStats {
    activeCount: number;
    activeVolume: number;
    ejectedVolumeTotal: number;
    returnedVolumeTotal: number;
    reserveVolumeTotal: number;
    stepDurationMs: number;
}

export interface SandGranules {
    spawnFootEjection(
        footPos: { x: number; y: number; z: number },
        footVel?: { x: number; z: number } | null,
        count?: number,
        intensity?: number,
        withdrawFn?: ((x: number, z: number, reqVol: number) => number) | null
    ): void;
    spawnThrusterBurst(
        centerPos: { x: number; y: number; z: number },
        count?: number,
        intensity?: number,
        withdrawFn?: ((x: number, z: number, reqVol: number) => number) | null
    ): void;
    update(dt: number, env?: any): void;
    getActiveCount(): number;
    getTotalVolume(): number;
    getStats(): GranulesStats;
    dispose(): void;
}

export function createSandGranules({
    scene,
    rng = createRng(42),
    withdrawMass = null,
    depositMass = null,
    sampleHeight = null,
    sampleGround = null,
    addReserve = null
}: SandGranulesOptions): SandGranules {
    const defaultWithdrawMass = withdrawMass;
    const defaultDepositMass = depositMass;
    const defaultSampleHeight = sampleHeight;
    const defaultSampleGround = sampleGround;
    const defaultAddReserve = addReserve;
    const tmpWind = new THREE.Vector3();

    // Статистика и баланс массы гранул
    let totalActiveVolume = 0.0;
    let totalEjectedVolume = 0.0;
    let totalReturnedVolume = 0.0;
    let totalReserveVolume = 0.0;
    let lastStepDurationMs = 0.0;

    // Геометрия зерна песка: мелкая крупинка в духе PS1 (4.8 см вместо 18 см),
    // чтобы струи из-под лап меха, стоп Cosmo и колеса мотоцикла читались как песок.
    const granuleGeom = new THREE.BoxGeometry(0.048, 0.048, 0.048);
    const granuleMat = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        color: PALETTE.sandParticle,
        flatShading: true
    }), PS1_SNAP.terrain);

    const instanced = new THREE.InstancedMesh(granuleGeom, granuleMat, MAX_GRANULES);
    instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    instanced.frustumCulled = false;
    scene.add(instanced);

    // Быстрые типизированные массивы для состояния частиц
    const posX = new Float32Array(MAX_GRANULES);
    const posY = new Float32Array(MAX_GRANULES);
    const posZ = new Float32Array(MAX_GRANULES);
    const velX = new Float32Array(MAX_GRANULES);
    const velY = new Float32Array(MAX_GRANULES);
    const velZ = new Float32Array(MAX_GRANULES);
    const life = new Float32Array(MAX_GRANULES);
    const maxLife = new Float32Array(MAX_GRANULES);
    const scale = new Float32Array(MAX_GRANULES);
    const volume = new Float32Array(MAX_GRANULES);
    const active = new Uint8Array(MAX_GRANULES);

    const dummy = new THREE.Object3D();
    const grainColor = new THREE.Color();
    const grainPalette = [0xdca86e, 0xe8bc84, 0xc79258, 0xf2ce9c, 0xd19a61];
    dummy.position.set(0, -999, 0);
    dummy.scale.setScalar(0.001);
    dummy.updateMatrix();
    for (let i = 0; i < MAX_GRANULES; i++) {
        instanced.setMatrixAt(i, dummy.matrix);
        grainColor.setHex(grainPalette[i % grainPalette.length]);
        instanced.setColorAt(i, grainColor);
        posY[i] = -999;
    }
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;

    let activeCount = 0;
    let spawnCursor = 0;

    function emitGranule(
        x: number, y: number, z: number,
        vx: number, vy: number, vz: number,
        size: number, duration: number, massVol: number
    ): number {
        let index = -1;
        for (let attempt = 0; attempt < MAX_GRANULES; attempt++) {
            const i = (spawnCursor + attempt) % MAX_GRANULES;
            if (!active[i]) {
                index = i;
                break;
            }
        }
        if (index === -1) {
            index = spawnCursor % MAX_GRANULES;
            if (active[index] && volume[index] > 0) {
                if (defaultAddReserve) defaultAddReserve(volume[index]);
                totalReserveVolume += volume[index];
                totalActiveVolume -= volume[index];
                volume[index] = 0;
            }
        }
        spawnCursor = (index + 1) % MAX_GRANULES;

        if (!active[index]) activeCount++;
        active[index] = 1;
        posX[index] = x;
        posY[index] = y;
        posZ[index] = z;
        velX[index] = vx;
        velY[index] = vy;
        velZ[index] = vz;
        scale[index] = size;
        life[index] = 0;
        maxLife[index] = duration;
        volume[index] = massVol;
        totalActiveVolume += massVol;
        totalEjectedVolume += massVol;
        return index;
    }

    // Выброс зёрен из-под подошвы при переступании, сдвиге и пробуксовке
    function spawnFootEjection(
        footPos: { x: number; y: number; z: number },
        footVel: { x: number; z: number } | null = null,
        count: number = 16,
        intensity: number = 1.0,
        withdrawFn: ((x: number, z: number, reqVol: number) => number) | null = defaultWithdrawMass
    ): void {
        const c = Math.min(count, 48);
        const reqVol = c * 0.00015 * intensity;
        const fn = typeof withdrawFn === 'function' ? withdrawFn : (typeof defaultWithdrawMass === 'function' ? defaultWithdrawMass : null);
        const actualVol = fn ? fn(footPos.x, footPos.z, reqVol) : reqVol;
        if (actualVol <= 1e-7) return;

        const vGrain = actualVol / c;
        const fvx = footVel ? footVel.x : 0;
        const fvz = footVel ? footVel.z : 0;

        for (let i = 0; i < c; i++) {
            const spreadAngle = rng.between(0, Math.PI * 2);
            const spreadDist = rng.between(0.02, 0.22);
            const px = footPos.x + Math.cos(spreadAngle) * spreadDist;
            const pz = footPos.z + Math.sin(spreadAngle) * spreadDist;
            const py = footPos.y + rng.between(0.02, 0.08);

            // Струя песка летит назад от вектора движения стопы с веерным разбросом
            const ejectSpeed = rng.between(1.1, 3.2) * intensity;
            const dirX = -fvx * 0.7 + (rng.next() - 0.5) * 2.0;
            const dirZ = -fvz * 0.7 + (rng.next() - 0.5) * 2.0;
            const dirLen = Math.hypot(dirX, dirZ) || 1.0;

            const vx = (dirX / dirLen) * ejectSpeed;
            const vy = rng.between(0.95, 2.7) * intensity;
            const vz = (dirZ / dirLen) * ejectSpeed;
            const sz = rng.between(0.42, 0.82) * Math.min(1.15, Math.max(0.45, intensity));
            const dur = rng.between(0.5, 1.15);

            emitGranule(px, py, pz, vx, vy, vz, sz, dur, vGrain);
        }
    }

    // Выброс гранул от реактивных сопел при прыжке
    function spawnThrusterBurst(
        centerPos: { x: number; y: number; z: number },
        count: number = 64,
        intensity: number = 1.6,
        withdrawFn: ((x: number, z: number, reqVol: number) => number) | null = defaultWithdrawMass
    ): void {
        const c = Math.min(count, 96);
        const reqVol = c * 0.00025 * intensity;
        const fn = typeof withdrawFn === 'function' ? withdrawFn : (typeof defaultWithdrawMass === 'function' ? defaultWithdrawMass : null);
        const actualVol = fn ? fn(centerPos.x, centerPos.z, reqVol) : reqVol;
        if (actualVol <= 1e-7) return;

        const vGrain = actualVol / c;

        for (let i = 0; i < c; i++) {
            const angle = rng.between(0, Math.PI * 2);
            const speed = rng.between(3.2, 8.2) * intensity;
            const px = centerPos.x + (rng.next() - 0.5) * 0.95;
            const pz = centerPos.z + (rng.next() - 0.5) * 0.95;
            const py = centerPos.y + rng.between(0.04, 0.18);

            const vx = Math.cos(angle) * speed;
            const vy = rng.between(1.3, 4.2) * intensity;
            const vz = Math.sin(angle) * speed;
            const sz = rng.between(0.48, 0.92);
            const dur = rng.between(0.7, 1.5);

            emitGranule(px, py, pz, vx, vy, vz, sz, dur, vGrain);
        }
    }

    // Интеграция физики активных гранул
    function update(dt: number, env: any = {}): void {
        const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        let windX = 0.0;
        let windZ = 0.0;
        let sHeight = defaultSampleHeight;
        let sGround = defaultSampleGround;
        let dMass = defaultDepositMass;
        let aReserve = defaultAddReserve;

        if (typeof env === 'function') {
            // env передан как сэмплер ветра (например, weather.sampleWindInto)
            env(tmpWind, 0, 0);
            windX = tmpWind.x;
            windZ = tmpWind.z;
        } else if (env && typeof env === 'object') {
            if (typeof env.sampleWind === 'function') {
                env.sampleWind(tmpWind, 0, 0);
                windX = tmpWind.x;
                windZ = tmpWind.z;
            } else if (typeof env.sampleWindInto === 'function') {
                env.sampleWindInto(tmpWind, 0, 0);
                windX = tmpWind.x;
                windZ = tmpWind.z;
            } else {
                windX = env.windX || 0.0;
                windZ = env.windZ || 0.0;
            }
            if (typeof env.sampleHeight === 'function') sHeight = env.sampleHeight;
            if (typeof env.sampleGround === 'function') sGround = env.sampleGround;
            if (typeof env.depositMass === 'function') dMass = env.depositMass;
            if (typeof env.addReserve === 'function') aReserve = env.addReserve;
        }

        if (activeCount === 0 || dt <= 0) {
            lastStepDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
            return;
        }

        let rendered = 0;

        for (let i = 0; i < MAX_GRANULES; i++) {
            if (!active[i]) continue;

            life[i] += dt;
            if (life[i] >= maxLife[i]) {
                // Гранула исчерпала жизнь: не добавляем массу в случайную точку,
                // а возвращаем в мировой резерв
                if (volume[i] > 0) {
                    if (aReserve) aReserve(volume[i]);
                    else if (dMass) dMass(posX[i], posZ[i], volume[i]);
                    totalReserveVolume += volume[i];
                    totalActiveVolume -= volume[i];
                    volume[i] = 0;
                }
                active[i] = 0;
                activeCount--;
                dummy.position.set(0, -999, 0);
                dummy.scale.setScalar(0.001);
                dummy.updateMatrix();
                instanced.setMatrixAt(i, dummy.matrix);
                continue;
            }

            // Баллистика и сопротивление воздуха с ветром
            velY[i] -= GRAVITY * dt;
            const dvx = (windX - velX[i]) * WIND_DRAG * dt;
            const dvz = (windZ - velZ[i]) * WIND_DRAG * dt;
            velX[i] += dvx;
            velZ[i] += dvz;

            posX[i] += velX[i] * dt;
            posY[i] += velY[i] * dt;
            posZ[i] += velZ[i] * dt;

            // Столкновение с поверхностью (песок или твердый объект)
            let groundY = -999;
            let normalX = 0, normalY = 1, normalZ = 0;
            let isSolid = false;
            let groundFriction = GROUND_FRICTION;

            if (sGround) {
                const sample = sGround(posX[i], posZ[i]);
                if (sample) {
                    groundY = sample.y;
                    if (sample.normal) {
                        normalX = sample.normal.x;
                        normalY = sample.normal.y;
                        normalZ = sample.normal.z;
                    }
                    isSolid = sample.surfaceType === 'solid';
                    groundFriction = typeof sample.friction === 'number' ? sample.friction : GROUND_FRICTION;
                }
            } else if (sHeight) {
                groundY = sHeight(posX[i], posZ[i]);
            }

            if (posY[i] <= groundY + 0.02) {
                posY[i] = groundY + 0.02;

                // Разложение вектора скорости по нормали поверхности
                const vn = velX[i] * normalX + velY[i] * normalY + velZ[i] * normalZ;
                if (vn < 0) {
                    const vnx = vn * normalX;
                    const vny = vn * normalY;
                    const vnz = vn * normalZ;
                    const vtx = velX[i] - vnx;
                    const vty = velY[i] - vny;
                    const vtz = velZ[i] - vnz;

                    if (isSolid) {
                        // Камень/скала: более упругий отскок, скольжение по нормали, оседание запрещено
                        const rest = 0.42;
                        const fSlow = Math.max(0, 1.0 - groundFriction * dt * 4.0);
                        velX[i] = -vnx * rest + vtx * fSlow;
                        velY[i] = -vny * rest + vty * fSlow;
                        velZ[i] = -vnz * rest + vtz * fSlow;
                        // Скат вниз по уклону твердой поверхности
                        velX[i] += normalX * GRAVITY * 0.35 * dt;
                        velZ[i] += normalZ * GRAVITY * 0.35 * dt;
                    } else {
                        // Песок: неупругий удар, трение и оседание при малой скорости
                        const rest = RESTITUTION;
                        velX[i] = -vnx * rest + vtx * groundFriction;
                        velY[i] = -vny * rest + vtx * groundFriction;
                        velZ[i] = -vnz * rest + vtx * groundFriction;

                        const speedSq = velX[i] * velX[i] + velY[i] * velY[i] + velZ[i] * velZ[i];
                        if (speedSq < SETTLE_SPEED_SQ) {
                            // Оседает только на песке: возвращаем массу в L1
                            if (dMass && volume[i] > 0) {
                                const placed = dMass(posX[i], posZ[i], volume[i]);
                                totalReturnedVolume += placed;
                                const unplaced = volume[i] - placed;
                                if (unplaced > 0) {
                                    if (aReserve) aReserve(unplaced);
                                    totalReserveVolume += unplaced;
                                }
                                totalActiveVolume -= volume[i];
                                volume[i] = 0;
                            }
                            velX[i] = velY[i] = velZ[i] = 0;
                            active[i] = 0;
                            activeCount--;
                            dummy.position.set(0, -999, 0);
                            dummy.scale.setScalar(0.001);
                            dummy.updateMatrix();
                            instanced.setMatrixAt(i, dummy.matrix);
                            continue;
                        }
                    }
                }
            }

            const ageRatio = life[i] / Math.max(0.001, maxLife[i]);
            const taper = Math.max(0.18, 1.0 - 0.65 * ageRatio * ageRatio);
            dummy.position.set(posX[i], posY[i], posZ[i]);
            dummy.scale.setScalar(scale[i] * taper);
            dummy.updateMatrix();
            instanced.setMatrixAt(i, dummy.matrix);
            rendered++;
        }

        instanced.instanceMatrix.needsUpdate = true;
        lastStepDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    function dispose(): void {
        scene.remove(instanced);
        granuleGeom.dispose();
        granuleMat.dispose();
    }

    return {
        spawnFootEjection,
        spawnThrusterBurst,
        update,
        getActiveCount: () => activeCount,
        getTotalVolume: () => totalActiveVolume,
        getStats: () => ({
            activeCount,
            activeVolume: totalActiveVolume,
            ejectedVolumeTotal: totalEjectedVolume,
            returnedVolumeTotal: totalReturnedVolume,
            reserveVolumeTotal: totalReserveVolume,
            stepDurationMs: lastStepDurationMs
        }),
        dispose
    };
}

