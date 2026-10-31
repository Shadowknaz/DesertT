// Система частиц песка: клубы пыли из-под лап, всплески от кликов и ударов,
// а также фоновая поземка, которую несет настоящий ветер погоды.
// Один InstancedMesh на все частицы, физика — простой интегратор.
import * as THREE from 'three';
import { CHUNK, DUST, PALETTE, PS1_SNAP } from '../config.ts';
import { getDuneHeight } from '../core/duneField.ts';
import { applyPS1VertexSnap } from '../render/ps1Material.ts';
import type { Rng } from '../core/rng.ts';
import type { WeatherState } from './weather.ts';

const { maxParticles: MAX_PARTICLES } = DUST;

export interface DustSystemOptions {
    scene: THREE.Scene;
    windAt?: ((out: THREE.Vector3, x: number, z: number) => THREE.Vector3 | null) | null;
    rng?: Rng | null;
}

export interface Particle {
    active: boolean;
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    scale: number;
    life: number;
    maxLife: number;
}

export interface DustSystem {
    spawnSplash(origin: THREE.Vector3, count?: number, intensity?: number): void;
    spawnBurst(origin: THREE.Vector3, count?: number, intensity?: number): void;
    updateAmbient(focus: THREE.Vector3 | { x: number; y?: number; z: number }, dt: number, weather?: WeatherState | null): void;
    update(dt: number): void;
    dispose(): void;
}

export function createDustSystem({ scene, windAt = null, rng = null }: DustSystemOptions): DustSystem {
    const rnd = rng ? () => rng.next() : () => Math.random();
    const particleGeometry = new THREE.BoxGeometry(0.28, 0.28, 0.28);
    const particleMaterial = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        color: PALETTE.sandParticle,
        flatShading: true
    }), PS1_SNAP.terrain);

    const instanced = new THREE.InstancedMesh(particleGeometry, particleMaterial, MAX_PARTICLES);
    instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Частицы живут вокруг меха, а не в начале координат: стандартный
    // bounding sphere инстансов устаревает и может отсечь весь слой.
    instanced.frustumCulled = false;
    scene.add(instanced);

    const particles: Particle[] = [];
    const dummyObj = new THREE.Object3D();
    const wind = new THREE.Vector3();
    const jitter = new THREE.Vector3();
    let ambientAccumulator = 0.0;

    for (let i = 0; i < MAX_PARTICLES; i++) {
        particles.push({
            active: false,
            pos: new THREE.Vector3(0, -100, 0),
            vel: new THREE.Vector3(),
            scale: 1.0,
            life: 0,
            maxLife: 1.0
        });
        dummyObj.position.set(0, -100, 0);
        dummyObj.scale.setScalar(0.001);
        dummyObj.updateMatrix();
        instanced.setMatrixAt(i, dummyObj.matrix);
    }

    function sampleWindAt(x: number, z: number): THREE.Vector3 | null {
        if (!windAt) return null;
        return windAt(wind, x, z);
    }

    // Общий движок эммитера: находит свободные частицы и передает им
    // заполненный state. Эмиттеры ниже отличаются только профилем разлета.
    function emit(count: number, fillState: (p: Particle) => void): void {
        let spawned = 0;
        for (let i = 0; i < MAX_PARTICLES && spawned < count; i++) {
            const p = particles[i];
            if (p.active) continue;

            p.active = true;
            p.life = 0;
            fillState(p);
            spawned++;
        }
    }

    function spawnSplash(origin: THREE.Vector3, count = DUST.splash.count, intensity = DUST.splash.intensity): void {
        const s = DUST.splash;
        const gust = sampleWindAt(origin.x, origin.z);
        const windX = gust ? gust.x * s.windCoupling : 0.0;
        const windZ = gust ? gust.z * s.windCoupling : 0.0;

        emit(count, (p) => {
            p.maxLife = s.minLife + rnd() * s.lifeSpread;
            p.scale = (s.minScale + rnd() * s.scaleSpread) * intensity;
            jitter.set(
                (rnd() - 0.5) * s.jitter,
                0.15,
                (rnd() - 0.5) * s.jitter
            );
            p.pos.copy(origin).add(jitter);

            const angle = rnd() * Math.PI * 2;
            const speed = (s.minSpeed + rnd() * s.speedSpread) * intensity;
            p.vel.set(
                Math.cos(angle) * speed + windX,
                s.minRise + rnd() * s.risePerIntensity * intensity,
                Math.sin(angle) * speed + windZ
            );
        });
    }

    // Взрыв ракеты: широкий купол песка с быстрым разлетом во все стороны.
    // Отдельный эмиттер нужен, потому что spawnSplash поднимает узкий столб
    // над точкой удара, а разрыв должен накрыть площадь воронки.
    function spawnBurst(origin: THREE.Vector3, count = DUST.burst.count, intensity = DUST.burst.intensity): void {
        const b = DUST.burst;
        const gust = sampleWindAt(origin.x, origin.z);
        const windX = gust ? gust.x * b.windCoupling : 0.0;
        const windZ = gust ? gust.z * b.windCoupling : 0.0;

        emit(count, (p) => {
            const angle = rnd() * Math.PI * 2;
            const radius = rnd() * b.radiusJitter;

            p.maxLife = b.minLife + rnd() * b.lifeSpread;
            p.scale = (b.minScale + rnd() * b.scaleSpread) * intensity * b.scaleGain;
            p.pos.set(
                origin.x + Math.cos(angle) * radius,
                origin.y + 0.15 + rnd() * 0.5,
                origin.z + Math.sin(angle) * radius
            );

            const speed = (b.minSpeed + rnd() * b.speedSpread) * intensity * b.speedGain;
            p.vel.set(
                Math.cos(angle) * speed + windX,
                (b.minRise + rnd() * b.riseSpread) * intensity * b.riseGain,
                Math.sin(angle) * speed + windZ
            );
        });
    }

    // Фоновая пыль: рождается в кубе вокруг меха и улетает вместе с потоком.
    // Плотность и высота подъема растут вместе с силой погоды.
    function spawnAmbient(focus: THREE.Vector3 | { x: number; y?: number; z: number }, weather?: WeatherState | null): void {
        emit(1, (p) => {
            const a = DUST.ambient;
            const intensity = weather ? weather.intensity : a.fallbackIntensity;
            const spread = CHUNK.size * a.spread;
            const x = focus.x + (rnd() - 0.5) * spread;
            const z = focus.z + (rnd() - 0.5) * spread;
            const groundY = getDuneHeight(x, z);
            const lift = a.minLift + Math.pow(rnd(), a.liftBias) * (a.liftCalm + intensity * a.liftStorm);

            p.maxLife = a.minLife + rnd() * a.lifeSpread;
            p.scale = a.scaleBase + intensity * a.scaleIntensity + rnd() * a.scaleSpread;
            p.pos.set(x, groundY + lift, z);

            const gust = sampleWindAt(x, z);
            if (gust) {
                p.vel.set(gust.x * a.windCoupling, a.riseCalm + rnd() * a.riseSpread, gust.z * a.windCoupling);
            } else {
                p.vel.set(a.calmVelX, a.calmVelY, 0.0);
            }
        });
    }

    function updateAmbient(focus: THREE.Vector3 | { x: number; y?: number; z: number }, dt: number, weather?: WeatherState | null): void {
        const a = DUST.ambient;
        const intensity = weather ? weather.intensity : a.fallbackIntensity;
        const gust = weather ? weather.gust : 0.0;
        const rate = a.baseRate + intensity * a.intensityRate + gust * a.gustRate;

        ambientAccumulator = Math.min(a.maxQueued, ambientAccumulator + rate * dt);
        let budget = a.budgetPerFrame;
        while (ambientAccumulator >= 1.0 && budget > 0) {
            ambientAccumulator -= 1.0;
            budget--;
            spawnAmbient(focus, weather);
        }
    }

    function update(dt: number): void {
        const drag = Math.min(1.0, dt * DUST.dragPerSecond);

        for (let i = 0; i < MAX_PARTICLES; i++) {
            const p = particles[i];
            if (!p.active) continue;

            p.life += dt;
            if (p.life >= p.maxLife) {
                p.active = false;
                dummyObj.position.set(0, -100, 0);
                dummyObj.scale.set(0.001, 0.001, 0.001);
                dummyObj.updateMatrix();
                instanced.setMatrixAt(i, dummyObj.matrix);
                continue;
            }

            // Аэродинамическое сопротивление тянет песчинку к скорости ветра
            const gust = sampleWindAt(p.pos.x, p.pos.z);
            if (gust) {
                p.vel.x += (gust.x - p.vel.x) * drag;
                p.vel.z += (gust.z - p.vel.z) * drag;
            } else {
                p.vel.x += DUST.windBias * dt;
            }

            p.vel.y -= DUST.gravity * dt; // Гравитация песка
            p.pos.addScaledVector(p.vel, dt);

            const floorY = getDuneHeight(p.pos.x, p.pos.z);
            if (p.pos.y < floorY + DUST.restOffset) {
                p.pos.y = floorY + DUST.restOffset;
                p.vel.y *= -DUST.bounceRetain;
                p.vel.x *= DUST.friction;
                p.vel.z *= DUST.friction;
            }

            const s = p.scale * (1.0 - p.life / p.maxLife);
            dummyObj.position.copy(p.pos);
            dummyObj.scale.set(s, s, s);
            dummyObj.rotation.set(p.life * DUST.spinX, p.life * DUST.spinY, 0);
            dummyObj.updateMatrix();
            instanced.setMatrixAt(i, dummyObj.matrix);
        }
        instanced.instanceMatrix.needsUpdate = true;
    }

    function dispose(): void {
        if (instanced.parent) instanced.parent.remove(instanced);
        particleGeometry.dispose();
        particleMaterial.dispose();
        instanced.dispose();
    }

    return { spawnSplash, spawnBurst, updateAmbient, update, dispose };
}

